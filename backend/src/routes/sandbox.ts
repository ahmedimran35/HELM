// Sandbox sessions (qm-parity P1) — real, per-user shell execution.
//
// Each user gets a per-user working directory at
//   <repo>/tmp/sandbox/{user_id}/
// that persists across exec calls inside the same session. We never
// execute outside that directory tree (cwd is always pinned to it), and
// every spawned command is wrapped in `bash -lc` so PATH resolution and
// shell semantics are predictable.
//
// Safety notes (intentionally conservative for v1):
//   * Hard timeout enforced via `AbortSignal.timeout` — default 30s, max
//     5 minutes. The child is killed when the timer fires.
//   * Memory cap is declared in the response but NOT yet enforced via
//     `ulimit`/`prlimit` (Bun.spawn doesn't expose a portable resource-
//     limit knob across macOS/Linux). This is documented in the response
//     so callers know to treat exec as best-effort isolation, not a
//     hardened jail. A future phase should plumb real limits via
//     `unshare`/`firecracker` if we ever ship multi-tenant exec.
//   * No network egress filtering today (the user can run `curl`,
//     `wget`, etc.). Documented limitation; same future work applies.
//
// Every exec is audit-logged (`sandbox_exec`) with the cmd, exit code,
// duration, and per-session counter. Errors from the API layer (bad
// request, not found, forbidden) are surfaced with structured JSON.
//
// ============================================================================
// Isolation primitives — current state and future plan
// ============================================================================
//   primitive                status (default / SANDBOX_USE_UNSHARE=1)
//   ----------------------   ----------------------------------------
//   chroot / pivot_root      NOT IMPLEMENTED. Required for true FS jail.
//                            Plan: switch exec backend from Bun.spawn
//                            to a side-car helper that does
//                            `unshare --user --mount --map-root-user`
//                            and `chroot <sandbox-dir>`.
//   seccomp / syscall filter NOT IMPLEMENTED. Plan: ship a JSON seccomp
//                            profile denying ptrace, setuid, kexec,
//                            module-load, raw sockets; load via
//                            `unshare` + `--seccomp` once we move off
//                            Bun.spawn (Bun does not expose prctl).
//   network namespace        OPTIONAL via SANDBOX_USE_UNSHARE=1. When
//                            set, exec is wrapped in
//                            `unshare --net --user --map-root-user
//                            --mount-proc --pid --fork` which gives
//                            the child its own netns (no external
//                            connectivity by default).
//   resource limits          PARTIAL. Timeout enforced via setTimeout +
//                            proc.kill. Memory cap is hinted via
//                            HELM_SANDBOX_MEM_BUDGET_MB env but not
//                            enforced (Bun.spawn lacks portable rlimit
//                            knob). Plan: when exec moves into a
//                            side-car, set RLIMIT_AS/RLIMIT_CPU via
//                            prlimit before exec.
//   capability drop          NOT IMPLEMENTED. Plan: when we ship
//                            Firecracker microVMs for multi-tenant
//                            exec, the side-car runs as a non-root
//                            container with no_new_privs + cap_drop
//                            ALL, and each user gets its own VM.
//   apparmor / selinux       NOT IMPLEMENTED. Plan: ship an apparmor
//                            profile denying writes outside the
//                            user sandbox dir.
//   landlock                 NOT IMPLEMENTED. Plan: load a ruleset
//                            that pins FS access to <repo>/tmp/sandbox
//                            once Bun (or our side-car) supports it.
//
// Today the exec path is: `bash -c <cmd>` with PATH-stripped env and
// cwd pinned to the per-user sandbox dir. That is "basic" isolation.
//
// When SANDBOX_USE_UNSHARE=1 the path is upgraded to
//   `unshare --user --map-root-user --net --mount-proc --pid --fork
//    bash -c <cmd>`
// giving the child its own user + net + pid namespaces, and the API
// response reports `isolation: "unshare"`. Operators verify the mode
// from the per-exec response or the boot-time log line.
// ============================================================================

import { Hono } from "hono";
import { join, resolve, sep } from "node:path";
import { mkdir, rm, stat, readdir, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";

const router = new Hono();
router.use("*", requireAuth);

// Feature flag: when SANDBOX_USE_UNSHARE=1, wrap exec in `unshare --user
// --map-root-user --net --mount-proc --pid --fork` to give the child
// its own user + network + pid namespaces. Default off so macOS dev
// hosts (which lack unshare(1)) keep working — the kernel-mode primitives
// we want are Linux-only.
const USE_UNSHARE = process.env.SANDBOX_USE_UNSHARE === "1";
const ISOLATION_MODE: "basic" | "unshare" = USE_UNSHARE ? "unshare" : "basic";
// One-time boot-time log so operators can confirm which isolation path
// is active without poking at every exec response.
{
  // eslint-disable-next-line no-console
  console.log(
    USE_UNSHARE
      ? "[sandbox] isolation mode: unshare + net-ns"
      : "[sandbox] isolation mode: bash + env-strip",
  );
}

// Repo root = one above `src/`. We anchor all sandbox paths under
// `<repo>/tmp/sandbox/{user_id}/` so cleanup is "rm -rf tmp/sandbox"
// rather than nuking the user's actual $TMPDIR (which on macOS is
// `/var/folders/...` and is shared with the OS).
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SANDBOX_BASE = join(REPO_ROOT, "tmp", "sandbox");

// Default + hard cap on exec timeout. We expose the same cap in the
// audit metadata so admins can see when a session is being abused.
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB cap on stdout/stderr each

function sandboxDir(userId: string): string {
  return join(SANDBOX_BASE, userId);
}

function sessionDir(userId: string, sessionId: string): string {
  return join(sandboxDir(userId), "sessions", sessionId);
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

/**
 * Verify that `target` lives inside `root`. Used to defeat
 * `../`-escapes on user-supplied paths. Returns the resolved absolute
 * path on success, or `null` if the target escapes the root.
 */
function safeJoin(root: string, target: string): string | null {
  const cleaned = target.replace(/^\/+/, "");
  const full = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full === root) return full;
  if (!full.startsWith(rootWithSep)) return null;
  return full;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return crypto.subtle.digest("SHA-256", ab).then((d) =>
    Array.from(new Uint8Array(d))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

// ============================================================================
// Session lifecycle
// ============================================================================

// ----- create session -----
router.post("/sessions", async (c) => {
  const user = c.get("user");
  let body: { panel_id?: string; mode?: "shell" | "repl" };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      panel_id: { type: "uuid" },
      mode: { type: "enum", values: ["shell", "repl"] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  const mode = body.mode ?? "shell";
  // Membership check — without this, any user could attach a sandbox
  // session to any panel they can guess the UUID of, leaking the
  // session's existence (and any audit log mentioning panel_id) to
  // the panel's other members.
  if (body.panel_id) {
    const member = await sql<{ exists: number }[]>`
      SELECT EXISTS (
        SELECT 1 FROM panel_members
        WHERE panel_id = ${body.panel_id}::uuid
          AND user_id = ${user.id}::uuid
      )::int AS exists
    `;
    if ((member[0]?.exists ?? 0) === 0) {
      return c.json({ error: "panel_not_found_or_not_member" }, 404);
    }
  }
  // For repl sessions we default cwd to the session dir; shell sessions
  // default to the user's sandbox root.
  const cwd = mode === "repl" ? "/" : sandboxDir(user.id);
  await ensureDir(sandboxDir(user.id));
  const rows = await sql<{
    id: string;
    user_id: string;
    panel_id: string | null;
    mode: string;
    cwd: string;
    started_at: Date;
    ended_at: Date | null;
    exit_code: number | null;
    bytes_written: number;
    bytes_read: number;
  }[]>`
    INSERT INTO sandbox_sessions (user_id, panel_id, mode, cwd)
    VALUES (${user.id}::uuid, ${body.panel_id ?? null}::uuid, ${mode}, ${cwd})
    RETURNING id, user_id, panel_id, mode, cwd, started_at, ended_at,
              exit_code, bytes_written, bytes_read
  `;
  const session = rows[0]!;
  if (mode === "repl") {
    // Make a per-session scratch dir so repl output files are isolated.
    await ensureDir(sessionDir(user.id, session.id));
  }
  await logAudit({
    userId: user.id,
    target: session.id,
    action: "sandbox_session_started",
    metadata: { mode, panel_id: body.panel_id ?? null },
  });
  return c.json(session);
});

// ----- list sessions -----
router.get("/sessions", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    user_id: string;
    panel_id: string | null;
    mode: string;
    cwd: string;
    started_at: Date;
    ended_at: Date | null;
    exit_code: number | null;
    bytes_written: number;
    bytes_read: number;
  }[]>`
    SELECT id, user_id, panel_id, mode, cwd, started_at, ended_at,
           exit_code, bytes_written, bytes_read
    FROM sandbox_sessions
    WHERE user_id = ${user.id}::uuid
    ORDER BY started_at DESC
    LIMIT 100
  `;
  return c.json(rows);
});

// ----- get one session -----
router.get("/sessions/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    user_id: string;
    panel_id: string | null;
    mode: string;
    cwd: string;
    started_at: Date;
    ended_at: Date | null;
    exit_code: number | null;
    bytes_written: number;
    bytes_read: number;
  }[]>`
    SELECT id, user_id, panel_id, mode, cwd, started_at, ended_at,
           exit_code, bytes_written, bytes_read
    FROM sandbox_sessions
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

// ----- end session -----
router.post("/sessions/:id/end", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Mark ended first; then clean up scratch. If the row doesn't exist
  // (or belongs to another user) we 404.
  const upd = await sql<{ id: string; exit_code: number | null }[]>`
    UPDATE sandbox_sessions
    SET ended_at = now()
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
      AND ended_at IS NULL
    RETURNING id, exit_code
  `;
  if (upd.length === 0) {
    // Either doesn't exist, wrong owner, or already ended. Distinguish
    // 404 (not yours / not there) from 409 (already ended).
    const exists = await sql<{ id: string }[]>`
      SELECT id FROM sandbox_sessions
      WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
      LIMIT 1
    `;
    if (!exists[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "already_ended" }, 409);
  }
  // Best-effort cleanup of the session scratch dir.
  try {
    await rm(sessionDir(user.id, id), { recursive: true, force: true });
  } catch {
    /* swallow — cleanup is best-effort */
  }
  await logAudit({
    userId: user.id,
    target: id,
    action: "sandbox_session_ended",
  });
  return c.json({ ok: true, id: upd[0]!.id });
});

// ============================================================================
// Exec
// ============================================================================
router.post("/sessions/:id/exec", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  let body: { cmd?: string; stdin?: string; timeout_ms?: number };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      cmd: { type: "string", minLength: 1, maxLength: 64_000 },
      stdin: { type: "string", maxLength: 1_000_000 },
      timeout_ms: { type: "number", integer: true, min: 1, max: MAX_TIMEOUT_MS },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.cmd) {
    return c.json({ error: "cmd required" }, 400);
  }
  // Confirm the session exists + belongs to the caller and isn't
  // already ended.
  const sessRows = await sql<{ id: string; cwd: string; ended_at: Date | null }[]>`
    SELECT id, cwd, ended_at FROM sandbox_sessions
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  const sess = sessRows[0];
  if (!sess) return c.json({ error: "not_found" }, 404);
  if (sess.ended_at) return c.json({ error: "session_ended" }, 409);

  const timeoutMs = body.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const cwd = sandboxDir(user.id);
  await ensureDir(cwd);

  const startedAt = Date.now();
  // Pick the spawn command based on the SANDBOX_USE_UNSHARE flag.
  // Default: `bash -c <cmd>` (basic isolation).
  // With flag: `unshare --user --map-root-user --net --mount-proc --pid
  //   --fork bash -c <cmd>` — gives the child its own user, network,
  //   and pid namespaces. The netns means no external connectivity by
  //   default; only loopback is reachable inside the new namespace.
  const execCmd = USE_UNSHARE
    ? [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--mount-proc",
        "--pid",
        "--fork",
        "bash",
        "-c",
        body.cmd,
      ]
    : [
        // -c (not -lc): skips login profile scripts like /etc/profile and
        // ~/.bash_profile. Login shells read those on startup, and a hostile
        // admin who can drop a file into the sandbox cwd can use them to
        // persist code into every command the user runs. Non-login is the
        // right default for a sandboxed shell.
        "bash",
        "-c",
        body.cmd,
      ];
  const proc = Bun.spawn({
    cmd: execCmd,
    cwd,
    env: {
      // Restricted env: PATH only (no leaked secrets), HOME pinned to
      // the user's sandbox dir so `~` expansions stay inside.
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: cwd,
      TMPDIR: tmpdir(),
      // Hint the cap. Not enforced — see file header.
      HELM_SANDBOX_MEM_BUDGET_MB: "256",
    },
    stdin: body.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Feed stdin if provided, then close it so the child sees EOF. Bun's
  // `Subprocess.stdin` exposes a WritableStream — we getWriter → write →
  // release → close the stream so the child receives EOF.
  if (body.stdin) {
    const writer = (proc.stdin as unknown as WritableStream<Uint8Array>).getWriter();
    try {
      await writer.write(new TextEncoder().encode(body.stdin));
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed by the child */
      }
    }
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Read stdout/stderr concurrently, capped at MAX_OUTPUT_BYTES each so
  // a runaway command can't OOM the API process.
  const cap = async (
    stream: ReadableStream<Uint8Array>,
    max: number,
  ): Promise<{ text: string; truncated: boolean; bytes: number }> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        truncated = true;
        const allowed = value.byteLength - (total - max);
        if (allowed > 0) chunks.push(value.subarray(0, allowed));
        break;
      }
      chunks.push(value);
    }
    const len = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return { text: new TextDecoder().decode(merged), truncated, bytes: total };
  };

  let stdoutRes: { text: string; truncated: boolean; bytes: number };
  let stderrRes: { text: string; truncated: boolean; bytes: number };
  try {
    [stdoutRes, stderrRes] = await Promise.all([
      cap(proc.stdout as unknown as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
      cap(proc.stderr as unknown as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
    ]);
  } finally {
    clearTimeout(timer);
  }

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startedAt;

  // Update the session counters. exit_code: -1 marks "timed out" so the
  // UI can render it differently from a clean exit.
  await sql`
    UPDATE sandbox_sessions
    SET bytes_written = bytes_written + ${stdoutRes.bytes}::int,
        bytes_read    = bytes_read    + ${stderrRes.bytes}::int,
        exit_code     = ${timedOut ? -1 : exitCode}
    WHERE id = ${id}::uuid
  `;

  await logAudit({
    userId: user.id,
    target: id,
    action: "sandbox_exec",
    metadata: {
      cmd_preview: body.cmd.slice(0, 200),
      exit_code: timedOut ? -1 : exitCode,
      duration_ms: durationMs,
      stdout_bytes: stdoutRes.bytes,
      stderr_bytes: stderrRes.bytes,
      truncated: stdoutRes.truncated || stderrRes.truncated,
      timed_out: timedOut,
      timeout_ms: timeoutMs,
    },
  });

  return c.json({
    stdout: stdoutRes.text,
    stderr: stderrRes.text,
    stdout_truncated: stdoutRes.truncated,
    stderr_truncated: stderrRes.truncated,
    exit_code: timedOut ? -1 : exitCode,
    duration_ms: durationMs,
    timed_out: timedOut,
    session_id: id,
    // Surface which isolation primitive ran this command so operators
    // can verify the SANDBOX_USE_UNSHARE flag actually took effect.
    // `basic` = bash -c with env-strip; `unshare` = unshare + netns.
    isolation: ISOLATION_MODE,
  });
});

// ============================================================================
// Files in a session
// ============================================================================
// We namespace the underlying `files.name` as
//   .sandbox/<sessionId-short>/<sandbox_path>
// so two sessions (or a sandbox + workspace) can each have `main.py`
// without colliding on the (owner_user_id, name) unique index.
//
// `sandbox_path` is the user-facing relative path inside the session
// working directory. We split it into parent + leaf and store bytes in
// `file_blobs` exactly like the workspace Files tab.

const SANDBOX_NAME_PREFIX = ".sandbox/";

function sandboxInternalName(sessionId: string, sandboxPath: string): string {
  // First 8 hex chars of the session UUID are plenty to disambiguate
  // within a single user's file namespace.
  const short = sessionId.replace(/-/g, "").slice(0, 8);
  // Strip any leading slash so the join is clean.
  const clean = sandboxPath.replace(/^\/+/, "");
  return `${SANDBOX_NAME_PREFIX}${short}/${clean}`;
}

function parseSandboxName(internalName: string): string | null {
  if (!internalName.startsWith(SANDBOX_NAME_PREFIX)) return null;
  return internalName.slice(SANDBOX_NAME_PREFIX.length);
}

// ----- list files for a session -----
router.get("/sessions/:id/files", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Confirm session ownership first.
  const own = await sql<{ id: string }[]>`
    SELECT id FROM sandbox_sessions
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  const short = id.replace(/-/g, "").slice(0, 8);
  const prefix = `${SANDBOX_NAME_PREFIX}${short}/`;
  const rows = await sql<{
    id: string;
    name: string;
    size: string;
    mime_type: string | null;
    updated_at: Date;
    sha256: string | null;
  }[]>`
    SELECT f.id, f.name, f.size::text, f.mime_type, f.updated_at, b.sha256
    FROM files f LEFT JOIN file_blobs b ON b.id = f.blob_id
    WHERE f.owner_user_id = ${user.id}::uuid
      AND f.name LIKE ${prefix + "%"}
    ORDER BY f.name ASC
  `;
  return c.json(
    rows.map((r) => ({
      id: r.id,
      sandbox_path: parseSandboxName(r.name) ?? r.name,
      size: Number(r.size),
      mime_type: r.mime_type,
      updated_at: r.updated_at,
      sha256: r.sha256,
    })),
  );
});

// ----- write file -----
router.post("/files", async (c) => {
  const user = c.get("user");
  let body: { session_id?: string; sandbox_path?: string; content?: string; mime_type?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      session_id: { type: "uuid" },
      sandbox_path: { type: "string", minLength: 1, maxLength: 1024, trim: true },
      content: { type: "string", maxLength: 16 * 1024 * 1024 },
      mime_type: { type: "string", maxLength: 255 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.session_id || !body.sandbox_path || body.content === undefined) {
    return c.json({ error: "session_id, sandbox_path, content required" }, 400);
  }
  // Owner check.
  const own = await sql<{ id: string }[]>`
    SELECT id FROM sandbox_sessions
    WHERE id = ${body.session_id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  // Reject path traversal: every component must be a normal name and
  // the absolute resolved path must stay inside the user's sandbox dir.
  const target = safeJoin(sandboxDir(user.id), body.sandbox_path);
  if (target === null) {
    return c.json({ error: "sandbox_path escapes sandbox root" }, 400);
  }
  // Reject symlinks. Without this check, an attacker who created a
  // symlink with `exec({cmd:"ln -s /etc/passwd x"})` on a previous
  // session could overwrite the target on the next write — or read it
  // out of the sandbox via the GET /raw endpoint.
  const stat = await lstat(target).catch(() => null);
  if (stat && stat.isSymbolicLink()) {
    return c.json({ error: "sandbox_path is a symlink" }, 400);
  }
  // Persist bytes to disk in the user's working dir (so the next exec
  // call can see the file in $PWD) AND into file_blobs (so the API
  // can serve downloads without touching the filesystem).
  await ensureDir(sandboxDir(user.id));
  await mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true }).catch(() => {});
  const bytes = new TextEncoder().encode(body.content);
  await writeFile(target, bytes);
  const sha = await sha256Hex(bytes);
  const mime = body.mime_type ?? guessMime(body.sandbox_path);
  await sql.begin(async (tx) => {
    const blobRows = await tx<{ id: string }[]>`
      INSERT INTO file_blobs (mime_type, bytes, sha256, byte_size)
      VALUES (${mime}, ${bytes}::bytea, ${sha}, ${bytes.length}::bigint)
      RETURNING id
    `;
    const blobId = blobRows[0]!.id;
    const internalName = sandboxInternalName(body.session_id!, body.sandbox_path!);
    await tx`
      INSERT INTO files (owner_user_id, name, size, mime_type, blob_id, session_id, sandbox_path)
      VALUES (${user.id}::uuid, ${internalName}, ${bytes.length}::bigint,
              ${mime}, ${blobId}::uuid, ${body.session_id!}::uuid, ${body.sandbox_path!})
      ON CONFLICT (owner_user_id, name) WHERE owner_user_id IS NOT NULL DO UPDATE
        SET size = EXCLUDED.size,
            mime_type = EXCLUDED.mime_type,
            blob_id = EXCLUDED.blob_id,
            session_id = EXCLUDED.session_id,
            sandbox_path = EXCLUDED.sandbox_path,
            updated_at = now()
    `;
  });
  await logAudit({
    userId: user.id,
    target: body.session_id!,
    action: "sandbox_file_written",
    metadata: { sandbox_path: body.sandbox_path!, bytes: bytes.length, sha256: sha },
  });
  return c.json({ ok: true, sandbox_path: body.sandbox_path!, sha256: sha, byte_size: bytes.length });
});

// ----- read file -----
router.get("/files/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    name: string;
    sandbox_path: string | null;
    mime_type: string | null;
    bytes: Uint8Array;
  }[]>`
    SELECT f.name, f.sandbox_path, f.mime_type, b.bytes
    FROM files f JOIN file_blobs b ON b.id = f.blob_id
    WHERE f.id = ${id}::uuid
      AND f.owner_user_id = ${user.id}::uuid
      AND f.session_id IS NOT NULL
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  // Use the original name for the download header so the client sees
  // the friendly filename, not the namespaced internal one.
  const downloadName = r.sandbox_path ?? r.name;
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      "Content-Type": r.mime_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(downloadName)}"`,
    },
  });
});

// ----- on-disk snapshot of the session working dir -----
// Best-effort: walks the user's sandbox dir and returns relative paths
// + sizes. We do this rather than just reading from `files` because
// files created by exec (e.g. `python script.py > out.csv`) may not
// have been recorded via /api/sandbox/files.
router.get("/sessions/:id/tree", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const own = await sql<{ id: string }[]>`
    SELECT id FROM sandbox_sessions
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  const root = sandboxDir(user.id);
  const out: Array<{ path: string; size: number; mtime: string }> = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, childRel);
      } else if (e.isFile()) {
        try {
          const s = await stat(full);
          out.push({ path: childRel, size: s.size, mtime: s.mtime.toISOString() });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(root, "");
  // Sort: directories (none here) + files by path.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return c.json({ root: sandboxDir(user.id), files: out });
});

// ----- read a file from disk (best-effort, used by the file browser) -----
router.get("/sessions/:id/raw", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rel = c.req.query("path") ?? "";
  const own = await sql<{ id: string }[]>`
    SELECT id FROM sandbox_sessions
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  const target = safeJoin(sandboxDir(user.id), rel);
  if (target === null) {
    return c.json({ error: "path escapes sandbox root" }, 400);
  }
  // Reject symlinks — see write-path comment above.
  const stat = await lstat(target).catch(() => null);
  if (stat && stat.isSymbolicLink()) {
    return c.json({ error: "path is a symlink" }, 400);
  }
  try {
    const bytes = await readFile(target);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": guessMime(rel),
      },
    });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// ----- mime-type guess by extension -----
function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "txt":
    case "log":
    case "md":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "py":
      return "text/x-python";
    case "js":
    case "mjs":
      return "text/javascript";
    case "ts":
      return "text/typescript";
    case "sh":
      return "text/x-shellscript";
    case "html":
    case "htm":
      return "text/html";
    case "yaml":
    case "yml":
      return "text/yaml";
    default:
      return "application/octet-stream";
  }
}

export default router;
