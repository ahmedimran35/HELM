// File upload + vision understanding route (Tier 3 — Voice + Multimodal).
//
// This is a focused route separate from /api/workspace/files. The
// workspace tab route keeps the "Files" tab in the user workspace
// working as-is; this new route powers the chat input's paperclip +
// drag-drop flow and the describe/image-understanding feature.
//
//   POST   /api/files                    — multipart upload (panel_id, purpose)
//   POST   /api/files/:id/describe       — AI-generated description (vision/PDF/audio)
//   GET    /api/files/:id/download       — stream blob (mirrors workspace route)
//   DELETE /api/files/:id                — owner-only delete
//   GET    /api/files                    — list a user's uploaded files
//
// `purpose` is a hint for downstream consumers:
//   - "vision"      — image / PDF that should be described on upload
//   - "attachment"  — generic chat attachment (no auto-describe)
//   - "knowledge"   — long-lived doc intended for retrieval (future)

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { sanitizeContentDispositionFilename, UnsafeFilenameError } from "../lib/safe-filename.ts";
import { getHarnessByKind } from "../harness/router.ts";
import { mockHarness } from "../harness/mock.ts";
import type { HarnessMessage } from "../harness/types.ts";
import { logSecurityEvent } from "../lib/security-events.ts";

const router = new Hono();
router.use("*", requireAuth);

// Allowed purpose values for the `purpose` form field.
const ALLOWED_PURPOSES = ["vision", "attachment", "knowledge"] as const;
type FilePurpose = (typeof ALLOWED_PURPOSES)[number];

// Hard caps to keep accidental uploads cheap.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const AUDIO_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
]);

// ----- GET /api/files -----
//
// Returns the user's uploaded files (newest first) plus the same row
// shape the workspace route emits so the frontend can reuse components.
router.get("/", async (c) => {
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
    LIMIT 200
  `;
  return c.json(rows);
});

// ----- POST /api/files -----
//
// Multipart upload. Accepts:
//   - file        — required, the binary blob
//   - name        — required, ≤255 chars (display name)
//   - panel_id    — optional UUID; if present the file is attached to a panel
//   - purpose     — optional enum, default "attachment"
router.post("/", async (c) => {
  const user = c.get("user");
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }
  const form = await c.req.parseBody();
  const file = form["file"];
  const name = (form["name"] ?? "") as string;
  const panelIdRaw = (form["panel_id"] ?? "") as string;
  const purposeRaw = ((form["purpose"] ?? "attachment") as string).toLowerCase();
  if (!(file instanceof File)) {
    return c.json({ error: "file part required" }, 400);
  }
  if (!name || name.length > 255) {
    return c.json({ error: "name required (≤255 chars)" }, 400);
  }
  if (!ALLOWED_PURPOSES.includes(purposeRaw as FilePurpose)) {
    return c.json(
      { error: `purpose must be one of: ${ALLOWED_PURPOSES.join(", ")}` },
      400,
    );
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    // Surface a security event for oversized uploads. The 25 MB cap
    // is enforced here, but operators want a real-time signal when
    // someone is repeatedly trying to push >25 MB blobs (either a
    // buggy client or an attacker probing for the cap).
    logSecurityEvent({
      type: "large_upload",
      severity: "warn",
      userId: user.id,
      route: "/api/files",
      details: {
        byte_size: buf.byteLength,
        cap: MAX_UPLOAD_BYTES,
        purpose: purposeRaw,
      },
      ts: Date.now(),
    });
    return c.json(
      { error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)` },
      413,
    );
  }
  // If a panel_id is supplied, verify the user has access. The panels
  // route already enforces membership; we just need to confirm the
  // panel exists. A bad UUID means 400, a missing panel means 404.
  let panelId: string | null = null;
  if (panelIdRaw && panelIdRaw.length > 0) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(panelIdRaw)) {
      return c.json({ error: "panel_id must be a UUID" }, 400);
    }
    // Membership check — without this, any user could attach files to
    // any panel they can guess the UUID of, exposing them to panel
    // members.
    const member = await sql<{ exists: number }[]>`
      SELECT EXISTS (
        SELECT 1 FROM panel_members
        WHERE panel_id = ${panelIdRaw}::uuid AND user_id = ${user.id}::uuid
      )::int AS exists
    `;
    const allowed = user.role === "admin" || (member[0]?.exists ?? 0) > 0;
    if (!allowed) {
      return c.json({ error: "panel_not_found_or_not_member" }, 404);
    }
    panelId = panelIdRaw;
  }
  const sha = await sha256Hex(buf);
  const mime = file.type || "application/octet-stream";
  const blobRows = await sql<{ id: string }[]>`
    INSERT INTO file_blobs (mime_type, bytes, sha256, byte_size)
    VALUES (${mime}, ${buf}::bytea, ${sha}, ${buf.length}::bigint)
    RETURNING id
  `;
  const blobId = blobRows[0]!.id;
  const fileRows = await sql<{ id: string }[]>`
    INSERT INTO files (owner_user_id, panel_id, name, size, mime_type, blob_id)
    VALUES (${user.id}::uuid, ${panelId}::uuid, ${name}, ${buf.length}::bigint,
            ${mime}, ${blobId}::uuid)
    ON CONFLICT (owner_user_id, name) WHERE owner_user_id IS NOT NULL DO UPDATE
      SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
          panel_id = EXCLUDED.panel_id,
          blob_id = EXCLUDED.blob_id, updated_at = now()
    RETURNING id
  `;
  const fileId = fileRows[0]!.id;
  await logAudit({
    userId: user.id,
    target: fileId,
    action: "file_uploaded",
    metadata: {
      name,
      sha256: sha,
      byte_size: buf.length,
      purpose: purposeRaw,
      panel_id: panelId,
    },
  });
  return c.json({
    id: fileId,
    sha256: sha,
    byte_size: buf.length,
    mime_type: mime,
    panel_id: panelId,
    purpose: purposeRaw,
    name,
  });
});

// ----- GET /api/files/:id/download -----
router.get("/:id/download", async (c) => {
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
  // Force attachment disposition + nosniff + sandboxed CSP — these are
  // HTML-rendered browser types (text/html, image/svg+xml, application/xhtml+xml)
  // that an attacker could otherwise upload and host same-origin, then
  // script the user's session via XSS. Browsers must download them, not
  // render them.
  const dangerous = /^(text\/html|application\/xhtml|image\/svg|application\/xml)\b/i;
  const safeType = dangerous.test(r.mime_type ?? "")
    ? "application/octet-stream"
    : (r.mime_type || "application/octet-stream");
  // Sanitize the filename used in Content-Disposition. The old code did
  // `encodeURIComponent(r.name)` which leaks `"`, `\r`, `\n`, and `;`
  // — enough to inject a second `filename=` parameter and ship a
  // crafted `evil.html` to the user. `sanitizeContentDispositionFilename`
  // validates + emits both an ASCII fallback and an RFC 5987
  // `filename*=UTF-8''…` parameter.
  let cdHeader: string;
  try {
    cdHeader = sanitizeContentDispositionFilename(r.name).header;
  } catch (err) {
    // Hard-reject names that fail validation (path separators, control
    // chars, hidden files). Return a synthetic ASCII name rather than
    // the user's stored name — we don't want to expose their stored
    // value verbatim via a redirect-or-error leak path either.
    logSecurityEvent({
      type: "suspicious_payload",
      severity: "warn",
      userId: user.id,
      route: "/api/files/:id/download",
      details: { reason: (err as Error).message, file_id: id },
      ts: Date.now(),
    });
    cdHeader = `attachment; filename="download.bin"`;
  }
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      "Content-Type": safeType,
      "Content-Disposition": cdHeader,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// ----- DELETE /api/files/:id -----
router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql.begin(async (tx) => {
    const rows = await tx<{ blob_id: string | null }[]>`
      SELECT blob_id FROM files
      WHERE id = ${id}::uuid AND owner_user_id = ${user.id}::uuid
    `;
    const blobId = rows[0]?.blob_id ?? null;
    await tx`DELETE FROM files
      WHERE id = ${id}::uuid AND owner_user_id = ${user.id}::uuid`;
    if (blobId) {
      await tx`
        DELETE FROM file_blobs WHERE id = ${blobId}::uuid
          AND NOT EXISTS (SELECT 1 FROM files WHERE blob_id = ${blobId}::uuid)
      `;
    }
  });
  await logAudit({ userId: user.id, target: id, action: "file_deleted" });
  return c.json({ ok: true });
});

// ----- POST /api/files/:id/describe -----
//
// Returns an AI-generated description of a file. Three branches:
//   - image/*    → vision-capable multimodal call (data: URL)
//   - audio/*    → Whisper-style transcription (POSTs to /v1/audio/transcriptions)
//   - anything else (text/PDF/doc) → text extraction + summary
//
// Graceful fallback: if the openai harness isn't configured or the
// upstream call fails, we return a stub description with `stub: true`
// so the UI can still show *something* without crashing.
router.post("/:id/describe", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    name: string;
    mime_type: string;
    bytes: Uint8Array;
    byte_size: number;
  }[]>`
    SELECT f.name, f.mime_type, b.bytes, b.byte_size
    FROM files f JOIN file_blobs b ON b.id = f.blob_id
    WHERE f.id = ${id}::uuid AND f.owner_user_id = ${user.id}::uuid
  `;
  const file = rows[0];
  if (!file) return c.json({ error: "not_found" }, 404);

  const mime = (file.mime_type || "").toLowerCase();
  const bytes = new Uint8Array(file.bytes);
  const harness = getHarnessByKind("openai");

  // 1) Image — vision call.
  if (IMAGE_MIMES.has(mime)) {
    const description = await describeImage(harness, file.name, mime, bytes);
    await logAudit({
      userId: user.id,
      target: id,
      action: "file_described",
      metadata: { kind: "image", stub: description.stub ? "true" : "false" },
    });
    return c.json(description);
  }

  // 2) Audio — Whisper transcription.
  if (AUDIO_MIMES.has(mime)) {
    const transcript = await transcribeAudio(harness, file.name, mime, bytes);
    await logAudit({
      userId: user.id,
      target: id,
      action: "file_described",
      metadata: {
        kind: "audio",
        stub: transcript.stub ? "true" : "false",
        duration_ms: transcript.duration_ms,
      },
    });
    return c.json({
      kind: "audio",
      transcript: transcript.text,
      duration_ms: transcript.duration_ms,
      stub: transcript.stub,
    });
  }

  // 3) Text-ish — extract + summarise.
  const text = decodeTextLike(bytes, mime);
  if (text.length === 0) {
    return c.json({
      kind: "other",
      description: `[no description available for ${mime || "unknown"}]`,
      stub: true,
    });
  }
  const summary = await summariseText(harness, file.name, text);
  await logAudit({
    userId: user.id,
    target: id,
    action: "file_described",
    metadata: { kind: "text", stub: summary.stub ? "true" : "false" },
  });
  return c.json({
    kind: "text",
    description: summary.text,
    stub: summary.stub,
  });
});

// ============================================================================
// helpers
// ============================================================================

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function describeImage(
  harness: ReturnType<typeof getHarnessByKind>,
  name: string,
  mime: string,
  bytes: Uint8Array,
): Promise<{ kind: "image"; description: string; stub: boolean }> {
  const status = await harness.status();
  if (!status.configured) {
    return {
      kind: "image",
      description: stubImageDescription(name, mime, bytes),
      stub: true,
    };
  }
  // Build a data: URL — small enough to inline for vision.
  const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  const messages: HarnessMessage[] = [
    {
      role: "user",
      content:
        `Describe this image in detail. The filename is "${name}". ` +
        `Cover: subject matter, layout, text (if any), colour palette, ` +
        `and any notable objects. Return 3-6 short sentences.`,
    },
  ];
  try {
    const out = await runChatText(harness, {
      model: "gpt-4o-mini",
      messages,
      system:
        "You are a vision-capable assistant. Be concise and factual. " +
        "If the image is illegible, say so.",
      // Pass the image as a multi-part user message via raw JSON —
      // the harness openai.ts wraps to the chat/completions API which
      // natively accepts array content for vision-capable models.
      // We embed the dataUrl into the user message directly so the
      // openai harness's plain-text content pipeline can carry it.
      visionDataUrl: dataUrl,
    });
    return { kind: "image", description: out.text, stub: out.stub };
  } catch (err) {
    return {
      kind: "image",
      description: stubImageDescription(name, mime, bytes),
      stub: true,
    };
  }
}

function stubImageDescription(
  name: string,
  mime: string,
  bytes: Uint8Array,
): string {
  const kb = Math.round(bytes.byteLength / 1024);
  return `[stub description] ${name} (${mime || "image"}, ${kb} KB). ` +
    `No vision model is configured — add an OpenAI-compatible provider to enable image understanding.`;
}

async function transcribeAudio(
  harness: ReturnType<typeof getHarnessByKind>,
  name: string,
  mime: string,
  bytes: Uint8Array,
): Promise<{ text: string; duration_ms: number; stub: boolean }> {
  const status = await harness.status();
  if (!status.configured) {
    return {
      text: `[stub transcription] ${name} — ${bytes.byteLength} bytes. ` +
        `No OpenAI-compatible provider configured for Whisper.`,
      duration_ms: estimateAudioDuration(bytes.byteLength, mime),
      stub: true,
    };
  }
  // Use the openai-compat /v1/audio/transcriptions endpoint directly.
  const cfg = await pickOpenAIConfig();
  if (!cfg) {
    return {
      text: `[stub transcription] no API key`,
      duration_ms: 0,
      stub: true,
    };
  }
  try {
    const form = new FormData();
    const blob = new Blob([bytes.slice().buffer], { type: mime });
    form.append("file", blob, name);
    form.append("model", "whisper-1");
    form.append("response_format", "json");
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        text: `[whisper ${res.status}] ${text.slice(0, 200)}`,
        duration_ms: estimateAudioDuration(bytes.byteLength, mime),
        stub: true,
      };
    }
    const body = (await res.json()) as { text?: string };
    return {
      text: body.text ?? "",
      duration_ms: estimateAudioDuration(bytes.byteLength, mime),
      stub: false,
    };
  } catch (err) {
    // Don't leak the underlying error message — the transcript lands
    // in the DB and is returned to the client via the file metadata.
    console.warn("[files] whisper failed:", (err as Error).message);
    return {
      text: "[whisper failed: transcription error]",
      duration_ms: estimateAudioDuration(bytes.byteLength, mime),
      stub: true,
    };
  }
}

async function summariseText(
  harness: ReturnType<typeof getHarnessByKind>,
  name: string,
  text: string,
): Promise<{ text: string; stub: boolean }> {
  // Cap the text we feed in so we don't blow up the context window
  // for big files.
  const trimmed = text.length > 8000 ? text.slice(0, 8000) + "\n…[truncated]" : text;
  const status = await harness.status();
  if (!status.configured) {
    return {
      text: `[stub summary] ${name} — ${text.length} chars. No provider configured.`,
      stub: true,
    };
  }
  try {
    const out = await runChatText(harness, {
      model: "gpt-4o-mini",
      system:
        "Summarise the following document in 3-5 short sentences. " +
        "Capture the topic, key facts, and any named entities.",
      messages: [
        { role: "user", content: `File: ${name}\n\n${trimmed}` },
      ],
    });
    return { text: out.text, stub: out.stub };
  } catch {
    return { text: trimmed.slice(0, 600), stub: true };
  }
}

function decodeTextLike(bytes: Uint8Array, mime: string): string {
  // Cheap decoding — try UTF-8 first, fall back to latin1. Anything
  // binary (PDF, docx) will not decode meaningfully; the caller can
  // fall back to a stub.
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // Bun ships a fast base64 encoder — use it when available, else fall
  // back to a hand-rolled loop (still O(n)).
  const b64 = (globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (s: string) => string } } }).Buffer;
  if (b64 && typeof b64.from === "function") {
    return b64.from(bytes).toString("base64");
  }
  // Manual base64 (chunked to avoid call-stack limits on big blobs).
  const lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b1 = bytes[i]!;
    const b2 = bytes[i + 1]!;
    const b3 = bytes[i + 2]!;
    out += lookup[b1 >> 2];
    out += lookup[((b1 & 3) << 4) | (b2 >> 4)];
    out += lookup[((b2 & 15) << 2) | (b3 >> 6)];
    out += lookup[b3 & 63];
  }
  if (i < bytes.length) {
    const b1 = bytes[i]!;
    const b2 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    out += lookup[b1 >> 2];
    out += lookup[((b1 & 3) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? lookup[(b2 & 15) << 2] : "=";
    out += "=";
  }
  return out;
}

function estimateAudioDuration(byteLength: number, mime: string): number {
  // Rough estimate: webm/opus at ~32 kbps ≈ 4 KB/s.
  if (mime.includes("webm") || mime.includes("ogg") || mime.includes("opus")) {
    return Math.round((byteLength / 4096) * 1000);
  }
  // mp3 at 128 kbps ≈ 16 KB/s.
  return Math.round((byteLength / 16384) * 1000);
}

interface ChatRunInput {
  model: string;
  system?: string;
  messages: HarnessMessage[];
  visionDataUrl?: string;
}

interface ChatRunOutput {
  text: string;
  stub: boolean;
}

async function runChatText(
  harness: ReturnType<typeof getHarnessByKind>,
  input: ChatRunInput,
): Promise<ChatRunOutput> {
  // The openai harness's chat() expects messages as a string. For
  // vision we need the array-of-parts content shape. We reach into
  // the underlying fetch by calling the /chat/completions endpoint
  // directly here rather than expanding the harness surface — keeps
  // the abstraction thin.
  const cfg = await pickOpenAIConfig();
  if (!cfg) {
    return { text: "[openai not configured]", stub: true };
  }
  const userMessage = input.visionDataUrl
    ? ([
        { type: "text", text: input.messages[0]?.content ?? "Describe this image." },
        { type: "image_url", image_url: { url: input.visionDataUrl } },
      ] as unknown as HarnessMessage["content"])
    : input.messages[0]?.content ?? "";
  const messages: Array<Record<string, unknown>> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: userMessage });
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages,
        temperature: 0.4,
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      // Touch mockHarness so the linter doesn't drop the unused import
      // when a downstream refactor removes the only call site.
      void mockHarness;
      return { text: `[openai ${res.status}] ${t.slice(0, 200)}`, stub: true };
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    return { text, stub: false };
  } catch (err) {
    // Don't leak the underlying error message — the summary lands in
    // the DB and is returned to the client via the file metadata.
    console.warn("[files] openai fetch failed:", (err as Error).message);
    return {
      text: "[openai fetch failed: model error]",
      stub: true,
    };
  }
}

async function pickOpenAIConfig(): Promise<{ baseUrl: string; apiKey: string } | null> {
  const rows = await sql<{ type: string; base_url: string; api_key_encrypted: string }[]>`
    SELECT type, base_url, api_key_encrypted FROM providers
    WHERE type IN ('openai', 'openai-compatible', 'nvidia-nim')
    ORDER BY (type = 'openai') DESC, added_at ASC LIMIT 1
  `;
  const row = rows[0];
  if (row) {
    // Reuse the registry helper rather than importing crypto directly
    // — same code path the openai harness uses.
    const { decryptSecret } = await import("../providers/crypto.ts");
    const apiKey = decryptSecret(row.api_key_encrypted);
    const baseUrl = row.type === "openai"
      ? "https://api.openai.com/v1"
      : (row.base_url.endsWith("/") ? row.base_url.slice(0, -1) : row.base_url);
    // SSRF guard — the chat/files/voice harnesses previously bypassed
    // this check. An admin-tampered provider row could pivot vision
    // requests to an attacker-controlled URL.
    try {
      const { assertSafeBaseUrl } = await import("../providers/registry.ts");
      await assertSafeBaseUrl(baseUrl, { allowAnyPort: true });
    } catch {
      return null;
    }
    return { baseUrl, apiKey };
  }
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.length > 0) {
    return { baseUrl: "https://api.openai.com/v1", apiKey: envKey };
  }
  return null;
}

export default router;