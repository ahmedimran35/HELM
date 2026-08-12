// Workspace tabs (docs §2.4): Memory, Files, Sandbox, Keychain, Crons,
// Posture. All tabs persist real data — files are stored as BLOBs in
// Postgres (file_blobs), sandbox reads CPU/mem from Bun's process
// resource usage, crons compute next_run_at from a real cron expression
// parser, posture is per-tool strict/auto, keychain never returns raw
// secrets (docs §8.4).

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { computeNextRun } from "../lib/cron.ts";
import { recall, ingest } from "../lib/memory-strategies/index.ts";
import type { MemoryEntry, MemoryScope } from "../lib/memory-strategies/types.ts";

const router = new Hono();
router.use("*", requireAuth);

// ----- Memory (real, three scopes) ----------------------------------------
//
// Scope rules:
//   'personal' — only the creator sees it; only the creator can edit/delete
//   'team'     — every authenticated user sees it; admins + creator can delete
//   'admin'    — only admins see it; only admins can write/delete
//
// We inject personal + team memory into the AI's context for every
// chat / panel call (see `injectMemoryIntoContext` below), so the
// memory is real and lightweight: no vector search, just a recent
// 50-entry cap and a flat prompt-block.
//
// ----- list -----
router.get("/memory", async (c) => {
  const user = c.get("user");
  const scopes: Array<[MemoryScope, string | null]> = [["personal", user.id], ["team", null]];
  if (user.role === "admin") scopes.push(["admin", null]);
  const batches = await Promise.all(scopes.map(([scope, scopeId]) => recall("", scope, scopeId, 200)));
  const seen = new Set<string>();
  const rows = batches.flat().filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 200);
  return c.json(rows);
});

// ----- create -----
router.post("/memory", async (c) => {
  const user = c.get("user");
  let body: {
    text?: string;
    scope?: "personal" | "team" | "admin";
    source_type?: "chat" | "panel" | "manual";
    source_id?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      text: { type: "string", minLength: 1, maxLength: 4000, trim: true },
      scope: { type: "enum", values: ["personal", "team", "admin"] },
      source_type: { type: "enum", values: ["chat", "panel", "manual"] },
      source_id: { type: "uuid" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.text) {
    return c.json({ error: "text required" }, 400);
  }
  const scope = body.scope ?? "personal";
  // Only admins can write 'admin'-scope entries.
  if (scope === "admin" && user.role !== "admin") {
    return c.json({ error: "admin role required to write admin-scope memory" }, 403);
  }
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    user_id: user.id,
    text: body.text,
    source_type: body.source_type ?? "manual",
    source_id: body.source_id ?? null,
    scope,
    created_at: new Date(),
  };
  await ingest(entry, scope, scope === "personal" ? user.id : null);
  return c.json({ id: entry.id, scope });
});

// ----- delete -----
router.delete("/memory/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Personal: only the owner can delete.
  // Team:     the creator or any admin can delete.
  // Admin:    only admins can delete.
  const result = await sql`
    DELETE FROM memory_entries
    WHERE id = ${id}::uuid
      AND (
        (scope = 'personal' AND user_id = ${user.id}::uuid)
        OR (scope = 'team' AND (user_id = ${user.id}::uuid OR ${user.role}::text = 'admin'))
        OR (scope = 'admin' AND ${user.role}::text = 'admin')
      )
  `;
  if (result.count === 0) {
    return c.json({ error: "not found or not allowed" }, 404);
  }
  return c.json({ ok: true });
});

// ----- Files (real multipart upload → file_blobs BLOB) --------------------
router.get("/files", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    name: string;
    size: string;
    mime_type: string | null;
    panel_id: string | null;
    updated_at: Date;
    sha256: string | null;
  }[]>`
    SELECT f.id, f.name, f.size::text, f.mime_type, f.panel_id, f.updated_at, b.sha256
    FROM files f LEFT JOIN file_blobs b ON b.id = f.blob_id
    WHERE f.owner_user_id = ${user.id}::uuid
    ORDER BY f.updated_at DESC
  `;
  return c.json(rows);
});

router.post("/files", async (c) => {
  const user = c.get("user");
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }
  const form = await c.req.parseBody();
  const file = form["file"];
  const name = (form["name"] ?? "") as string;
  if (!(file instanceof File)) {
    return c.json({ error: "file part required" }, 400);
  }
  if (!name || name.length > 255) {
    return c.json({ error: "name required (≤255 chars)" }, 400);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(buf);
  const blobRows = await sql<{ id: string }[]>`
    INSERT INTO file_blobs (mime_type, bytes, sha256, byte_size)
    VALUES (${file.type || "application/octet-stream"}, ${buf}::bytea, ${sha}, ${buf.length}::bigint)
    RETURNING id
  `;
  const blobId = blobRows[0]!.id;
  // Upsert into files; dedupe by (owner, name) so re-upload replaces.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO files (owner_user_id, name, size, mime_type, blob_id)
    VALUES (${user.id}::uuid, ${name}, ${buf.length}::bigint,
            ${file.type || "application/octet-stream"}, ${blobId}::uuid)
    ON CONFLICT (owner_user_id, name) WHERE owner_user_id IS NOT NULL DO UPDATE
      SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
          blob_id = EXCLUDED.blob_id, updated_at = now()
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "file_uploaded",
    metadata: { name, sha256: sha, byte_size: buf.length },
  });
  return c.json({ id: rows[0]!.id, sha256: sha, byte_size: buf.length });
});

router.get("/files/:id/download", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    name: string;
    mime_type: string;
    bytes: Uint8Array;
  }[]>`
    SELECT f.name, f.mime_type, b.bytes
    FROM files f JOIN file_blobs b ON b.id = f.blob_id
    WHERE f.id = ${id}::uuid AND f.owner_user_id = ${user.id}::uuid
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      "Content-Type": r.mime_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(r.name)}"`,
    },
  });
});

router.delete("/files/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Drop the blob reference first; only garbage-collect the blob when
  // nothing else references it.
  await sql.begin(async (tx) => {
    const rows = await tx<{ blob_id: string | null }[]>`
      SELECT blob_id FROM files WHERE id = ${id}::uuid AND owner_user_id = ${user.id}::uuid
    `;
    const blobId = rows[0]?.blob_id ?? null;
    await tx`DELETE FROM files WHERE id = ${id}::uuid AND owner_user_id = ${user.id}::uuid`;
    if (blobId) {
      await tx`
        DELETE FROM file_blobs WHERE id = ${blobId}::uuid
          AND NOT EXISTS (SELECT 1 FROM files WHERE blob_id = ${blobId}::uuid)
      `;
    }
  });
  return c.json({ ok: true });
});

// ----- Sandbox (real per-process metrics) ---------------------------------
// We don't ship a container runtime. Instead, the sandbox reflects the
// Bun process that backs the user's "agent runtime" — running / stopped
// toggles the status, and CPU/memory come from process.resourceUsage().
// Real, deterministic, no mock numbers. We sample cumulative CPU
// time every 5 s, and on each read we compute the *delta* over the
// last sample interval — that's the percent of one core the agent
// runtime has been using.
let sandboxProcessStartedAt = Date.now();
let lastSampleAt = Date.now();
let lastSampleCpuUs = 0;
let lastSampleCpuPct = 0;
let sandboxCpuTick: ReturnType<typeof setInterval> | null = null;

function ensureSandboxLoop() {
  if (sandboxCpuTick) return;
  // Seed the baseline before we start the loop so the first read
  // has a delta to compute against.
  const u0 = process.resourceUsage?.();
  if (u0) {
    lastSampleAt = Date.now();
    lastSampleCpuUs = u0.userCPUTime + u0.systemCPUTime;
  }
  sandboxCpuTick = setInterval(() => {
    const u = process.resourceUsage?.();
    if (!u) return;
    const now = Date.now();
    const totalUs = u.userCPUTime + u.systemCPUTime;
    const dtMs = now - lastSampleAt;
    if (dtMs > 0 && totalUs > lastSampleCpuUs) {
      // Percent of one core: 1 second of CPU time over 1 second of
      // wall time = 100%. (Cumulative cpu - last cpu) / dt in ms.
      const cpuMs = (totalUs - lastSampleCpuUs) / 1000;
      lastSampleCpuPct = Math.max(0, Math.min(100, (cpuMs / dtMs) * 100));
    }
    lastSampleAt = now;
    lastSampleCpuUs = totalUs;
  }, 5_000);
}
ensureSandboxLoop();

function readProcessMetrics(): { cpu_pct: number; mem_pct: number; uptime_s: number } {
  const u = process.resourceUsage?.();
  const mem = process.memoryUsage?.();
  const rss = mem?.rss ?? 0;
  const maxRss = (Bun.env?.HELM_SANDBOX_MEM_BUDGET_BYTES
    ? Number(Bun.env.HELM_SANDBOX_MEM_BUDGET_BYTES)
    : 512 * 1024 * 1024);
  return {
    // The most recently sampled delta of CPU usage, capped to 100%.
    cpu_pct: lastSampleCpuPct,
    mem_pct: Math.min(100, (rss / maxRss) * 100),
    uptime_s: u ? Math.floor((Date.now() - sandboxProcessStartedAt) / 1000) : 0,
  };
}

router.get("/sandbox", async (c) => {
  const user = c.get("user");
  const rows = await sql<{ status: string; last_reset_at: Date }[]>`
    SELECT status, last_reset_at FROM sandboxes WHERE user_id = ${user.id}::uuid LIMIT 1
  `;
  if (!rows[0]) {
    await sql`
      INSERT INTO sandboxes (user_id, status) VALUES (${user.id}::uuid, 'stopped')
      ON CONFLICT DO NOTHING
    `;
  }
  const m = readProcessMetrics();
  return c.json({
    status: rows[0]?.status ?? "stopped",
    cpu_pct: m.cpu_pct,
    mem_pct: m.mem_pct,
    uptime_s: m.uptime_s,
    last_reset_at: rows[0]?.last_reset_at ?? null,
  });
});

router.post("/sandbox/restart", async (c) => {
  const user = c.get("user");
  sandboxProcessStartedAt = Date.now();
  lastSampleCpuPct = 0;
  // Upsert so the first restart for a brand-new account works.
  await sql`
    INSERT INTO sandboxes (user_id, status, last_reset_at)
    VALUES (${user.id}::uuid, 'running', now())
    ON CONFLICT (user_id) DO UPDATE
      SET status = 'running', last_reset_at = now()
  `;
  await logAudit({ userId: user.id, target: "sandbox", action: "sandbox_restart" });
  return c.json({ ok: true, status: "running" });
});

router.post("/sandbox/stop", async (c) => {
  const user = c.get("user");
  await sql`
    INSERT INTO sandboxes (user_id, status) VALUES (${user.id}::uuid, 'stopped')
    ON CONFLICT (user_id) DO UPDATE SET status = 'stopped'
  `;
  await logAudit({ userId: user.id, target: "sandbox", action: "sandbox_stop" });
  return c.json({ ok: true, status: "stopped" });
});

// ----- Keychain (grants, masked) ------------------------------------------
router.get("/keychain", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    credential_name: string;
    scope: string;
    granted_by: string | null;
    granted_at: Date;
  }[]>`
    SELECT id, credential_name, scope, granted_by, granted_at
    FROM keychain_grants
    WHERE user_id = ${user.id}::uuid
    ORDER BY credential_name ASC
  `;
  return c.json(
    rows.map((r) => ({
      ...r,
      value_masked: "••••••••",
    })),
  );
});

// ----- Crons (real cron-parser for next_run_at) ---------------------------
router.get("/crons", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    name: string;
    schedule: string;
    last_run_at: Date | null;
    next_run_at: Date | null;
    enabled: boolean;
    last_status: string | null;
    last_result: string | null;
  }[]>`
    SELECT c.id, c.name, c.schedule, c.last_run_at, c.next_run_at, c.enabled,
           (SELECT status FROM cron_runs WHERE cron_id = c.id ORDER BY started_at DESC LIMIT 1) AS last_status,
           (SELECT result FROM cron_runs WHERE cron_id = c.id ORDER BY started_at DESC LIMIT 1) AS last_result
    FROM crons c WHERE c.user_id = ${user.id}::uuid
    ORDER BY c.created_at ASC
  `;
  return c.json(rows);
});

router.post("/crons", async (c) => {
  const user = c.get("user");
  let body: { name?: string; schedule?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      schedule: { type: "string", minLength: 1, maxLength: 120, trim: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.name || !body.schedule) {
    return c.json({ error: "name and schedule required" }, 400);
  }
  const next = computeNextRun(body.schedule);
  if (!next) {
    return c.json({ error: "schedule is not a valid cron expression" }, 400);
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crons (user_id, name, schedule, next_run_at)
    VALUES (${user.id}::uuid, ${body.name}, ${body.schedule}, ${next}::timestamptz)
    RETURNING id
  `;
  return c.json({ id: rows[0]!.id, next_run_at: next });
});

router.post("/crons/:id/toggle", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`
    UPDATE crons SET enabled = NOT enabled
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
  `;
  return c.json({ ok: true });
});

router.delete("/crons/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`DELETE FROM crons WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  return c.json({ ok: true });
});

router.post("/crons/:id/run", async (c) => {
  // Manual trigger — runs the cron now, persists a cron_runs row, and
  // computes the next_run_at. Real execution (calls the agent with the
  // cron's name as the prompt) is wired in Phase 6 cron engine; for now
  // this persists the run record and bumps schedule metadata.
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{ schedule: string }[]>`
    SELECT schedule FROM crons WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const next = computeNextRun(rows[0].schedule);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO cron_runs (cron_id, user_id, status, result)
      VALUES (${id}::uuid, ${user.id}::uuid, 'ok', 'manual trigger accepted')
    `;
    await tx`
      UPDATE crons
      SET last_run_at = now(), next_run_at = ${next}::timestamptz
      WHERE id = ${id}::uuid
    `;
  });
  return c.json({ ok: true, next_run_at: next });
});

// ----- Tool posture (per-tool: strict | auto) -----------------------------
router.get("/posture", async (c) => {
  const user = c.get("user");
  const rows = await sql<{ tool_name: string; posture: string }[]>`
    SELECT tool_name, posture FROM tool_posture WHERE user_id = ${user.id}::uuid
  `;
  const tools = ["web_search", "code_execution", "file_write", "slack_post", "email_send"];
  const byTool = new Map(rows.map((r) => [r.tool_name, r.posture]));
  return c.json(
    tools.map((t) => ({
      tool_name: t,
      posture: byTool.get(t) ?? "auto",
    })),
  );
});

router.post("/posture", async (c) => {
  const user = c.get("user");
  let body: { tool_name?: string; posture?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      tool_name: { type: "enum", values: ["web_search", "code_execution", "file_write", "slack_post", "email_send"] },
      posture: { type: "enum", values: ["strict", "auto"] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.tool_name || !body.posture) {
    return c.json({ error: "tool_name + posture required" }, 400);
  }
  await sql`
    INSERT INTO tool_posture (user_id, tool_name, posture)
    VALUES (${user.id}::uuid, ${body.tool_name}, ${body.posture})
    ON CONFLICT (user_id, tool_name) DO UPDATE
    SET posture = EXCLUDED.posture, updated_at = now()
  `;
  return c.json({ ok: true });
});

// ----- helpers ------------------------------------------------------------
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle expects a BufferSource that is an ArrayBuffer; Uint8Array
  // backed by SharedArrayBuffer needs a copy so the types line up.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----- helpers ------------------------------------------------------------

/** Build the "## Known context" block that gets injected into every
 *  AI call. The block lists the user's personal memory + the shared
 *  team memory (visible to everyone) — admins also see admin-scope
 *  memory. Real, lightweight, no vector search: a single SQL
 *  query per call returns the most recent 50 entries.
 *
 *  The returned string is a markdown block ready to drop into the
 *  system-prompt context window of the AI model. */
export async function buildMemoryContext(user: { id: string; role: string }): Promise<string> {
  const scopes: Array<[MemoryScope, string | null]> = [["personal", user.id], ["team", null]];
  if (user.role === "admin") scopes.push(["admin", null]);
  const batches = await Promise.all(scopes.map(([scope, scopeId]) => recall("", scope, scopeId, 50)));
  const seen = new Set<string>();
  const rows = batches.flat().filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 50);
  if (rows.length === 0) return "";
  const personal = rows.filter((r) => r.scope === "personal");
  const team = rows.filter((r) => r.scope === "team");
  const admin = rows.filter((r) => r.scope === "admin");
  const lines: string[] = [];
  if (personal.length > 0) {
    lines.push("### Your private notes (only you see these)");
    for (const r of personal) lines.push(`- ${r.text}`);
  }
  if (team.length > 0) {
    lines.push("");
    lines.push("### Team-shared notes (everyone sees these)");
    for (const r of team) {
      const author = r.user_name ? ` _(by ${r.user_name})_` : "";
      lines.push(`- ${r.text}${author}`);
    }
  }
  if (admin.length > 0) {
    lines.push("");
    lines.push("### Admin-only notes (only admins see these)");
    for (const r of admin) {
      const author = r.user_name ? ` _(by ${r.user_name})_` : "";
      lines.push(`- ${r.text}${author}`);
    }
  }
  return "## Known context (from the team's memory)\n\n" + lines.join("\n");
}

export default router;