// Voice recording + STT route (Tier 3).
//
//   POST /api/voice                 — multipart WebM upload → transcript
//   GET  /api/voice                 — list the user's recordings
//   GET  /api/voice/:id            — fetch one recording (audio + transcript)
//   DELETE /api/voice/:id          — owner-only delete
//
// On upload we:
//   1. store the audio bytes in file_blobs + a files row (so the
//      workspace "Files" tab also shows it),
//   2. insert a voice_recordings row with duration_ms + transcript,
//   3. attempt OpenAI Whisper; on failure store a stub transcript so
//      the rest of the flow (chat send, audit, etc.) still works.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

const ALLOWED_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
]);

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// ----- POST /api/voice -----
router.post("/", async (c) => {
  const user = c.get("user");
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }
  const form = await c.req.parseBody();
  const audio = form["audio"];
  const panelIdRaw = (form["panel_id"] ?? "") as string;
  const durationRaw = (form["duration_ms"] ?? "") as string;
  if (!(audio instanceof File)) {
    return c.json({ error: "audio part required" }, 400);
  }
  const mime = (audio.type || "audio/webm").toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    return c.json(
      { error: `unsupported audio type: ${mime || "unknown"}` },
      415,
    );
  }
  const buf = new Uint8Array(await audio.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return c.json({ error: "audio too large" }, 413);
  }
  let panelId: string | null = null;
  if (panelIdRaw && panelIdRaw.length > 0) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(panelIdRaw)) {
      return c.json({ error: "panel_id must be a UUID" }, 400);
    }
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
  // Client supplies duration_ms; cap to a sensible upper bound so a
  // buggy client can't insert a 10^9ms recording.
  let durationMs = Number(durationRaw);
  if (!Number.isFinite(durationMs) || durationMs <= 0) durationMs = 0;
  durationMs = Math.min(Math.max(0, Math.round(durationMs)), 1000 * 60 * 30); // 30 min

  // Persist audio as a file so it shows up in the workspace Files tab.
  const sha = await sha256Hex(buf);
  const blobRows = await sql<{ id: string }[]>`
    INSERT INTO file_blobs (mime_type, bytes, sha256, byte_size)
    VALUES (${mime}, ${buf}::bytea, ${sha}, ${buf.length}::bigint)
    RETURNING id
  `;
  const blobId = blobRows[0]!.id;
  const name = `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  const fileRows = await sql<{ id: string }[]>`
    INSERT INTO files (owner_user_id, panel_id, name, size, mime_type, blob_id)
    VALUES (${user.id}::uuid, ${panelId}::uuid, ${name}, ${buf.length}::bigint,
            ${mime}, ${blobId}::uuid)
    RETURNING id
  `;
  const fileId = fileRows[0]!.id;

  // Try to transcribe. On failure we still persist the row with a
  // placeholder transcript so the UI can show "no transcript".
  const transcript = await transcribe({
    name,
    mime,
    bytes: buf,
  });

  const vrRows = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO voice_recordings (user_id, panel_id, duration_ms, transcript, blob_ref)
    VALUES (${user.id}::uuid, ${panelId}::uuid, ${durationMs}, ${transcript.text},
            ${fileId}::uuid)
    RETURNING id, created_at
  `;
  const vr = vrRows[0]!;
  await logAudit({
    userId: user.id,
    target: vr.id,
    action: "voice_recorded",
    metadata: {
      duration_ms: durationMs,
      byte_size: buf.length,
      stub: transcript.stub ? "true" : "false",
    },
  });
  return c.json({
    id: vr.id,
    file_id: fileId,
    transcript: transcript.text,
    duration_ms: durationMs,
    stub: transcript.stub,
    created_at: vr.created_at,
  });
});

// ----- GET /api/voice -----
router.get("/", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    panel_id: string | null;
    duration_ms: number;
    transcript: string;
    blob_ref: string | null;
    created_at: Date;
  }[]>`
    SELECT id, panel_id, duration_ms, transcript, blob_ref, created_at
    FROM voice_recordings
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return c.json(rows);
});

// ----- GET /api/voice/:id -----
router.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    panel_id: string | null;
    duration_ms: number;
    transcript: string;
    blob_ref: string | null;
    mime_type: string | null;
    created_at: Date;
  }[]>`
    SELECT vr.id, vr.panel_id, vr.duration_ms, vr.transcript, vr.blob_ref,
           fb.mime_type, vr.created_at
    FROM voice_recordings vr
    LEFT JOIN files f ON f.id = vr.blob_ref
    LEFT JOIN file_blobs fb ON fb.id = f.blob_id
    WHERE vr.id = ${id}::uuid AND vr.user_id = ${user.id}::uuid
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

// ----- DELETE /api/voice/:id -----
router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql.begin(async (tx) => {
    await tx`DELETE FROM voice_recordings
      WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  });
  await logAudit({ userId: user.id, target: id, action: "voice_deleted" });
  return c.json({ ok: true });
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

async function transcribe(input: {
  name: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<{ text: string; stub: boolean }> {
  const cfg = await pickOpenAIConfig();
  if (!cfg) {
    return {
      text: "",
      stub: true,
    };
  }
  try {
    const form = new FormData();
    const blob = new Blob([input.bytes.slice().buffer], { type: input.mime });
    form.append("file", blob, input.name);
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
        stub: true,
      };
    }
    const body = (await res.json()) as { text?: string };
    return { text: body.text ?? "", stub: false };
  } catch (err) {
    return {
      text: `[whisper failed: ${(err as Error).message}]`,
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
    const { decryptSecret } = await import("../providers/crypto.ts");
    const apiKey = decryptSecret(row.api_key_encrypted);
    const baseUrl = row.type === "openai"
      ? "https://api.openai.com/v1"
      : (row.base_url.endsWith("/") ? row.base_url.slice(0, -1) : row.base_url);
    // SSRF guard — voice transcription now validates the base URL
    // before sending audio bytes (which may contain sensitive user
    // recordings) to it.
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