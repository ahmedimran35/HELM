// Tier 6 — auto-summarize older conversations.
//
// Walks messages older than N days, chunks them in groups of 20, and
// calls the harness to produce a 3-bullet summary. Each summary is then
// inserted as a single `system` row whose metadata points back at the
// source ids — that way nothing is truly lost; the UI can show the
// original transcripts on demand.
//
// The summarisation itself goes through the OpenAI harness by default so
// it works in any environment where /chat is operational. Admins can
// pin a specific model via the optional `model_id` argument.
//
// Safety net: NEVER delete the source messages. We only insert the
// summary alongside them so retrieval can still surface the originals if
// a future question needs exact quotes.

import { sql } from "../db/client.ts";
import { getHarnessByKind } from "../harness/router.ts";
import type { Harness } from "../harness/types.ts";

const CHUNK_SIZE = 20;
const DEFAULT_WINDOW_DAYS = 30;
const SUMMARISE_PROMPT =
  "Summarise the following conversation chunk into exactly 3 concise bullet points. " +
  "Capture the user's intent, key facts exchanged, and any decisions made. " +
  "Reply in markdown — start with a `## Summary` heading then 3 bullets. " +
  "Do not invent information that isn't in the messages. Be terse.";

export interface SummariseResult {
  panel_id: string;
  window_days: number;
  chunks: number;
  summaries_inserted: number;
  source_messages: number;
}

/**
 * Summarise messages older than `daysOld` days in the given panel.
 * Idempotent in the weak sense: re-running produces additional summary
 * rows for the same source messages. The summary's metadata records the
 * set of source ids so the UI can show "this summary covers N msgs".
 */
export async function autoSummarizePanel(
  panelId: string,
  daysOld: number = DEFAULT_WINDOW_DAYS,
): Promise<SummariseResult> {
  // Fetch the panel's messages older than the cutoff. We only summarise
  // user + assistant messages; system messages are skipped to avoid
  // nesting summaries inside summaries.
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const rows = await sql<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at: Date;
    sender_name: string | null;
  }[]>`
    SELECT id, role, content, created_at, sender_name
    FROM messages
    WHERE panel_id = ${panelId}::uuid
      AND created_at < ${cutoff.toISOString()}::timestamptz
      AND role IN ('user', 'assistant')
    ORDER BY created_at ASC
  `;

  if (rows.length === 0) {
    return {
      panel_id: panelId,
      window_days: daysOld,
      chunks: 0,
      summaries_inserted: 0,
      source_messages: 0,
    };
  }

  // Chunk. Each chunk is its own summary call so a long history gets
  // multiple summaries — much more useful than one giant blob.
  const harness = getHarnessByKind("openai");
  let summariesInserted = 0;
  let chunks = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    chunks++;
    const chunkText = chunk
      .map((m) => {
        const who = m.sender_name ?? (m.role === "user" ? "user" : "assistant");
        return `[${who}] ${m.content.slice(0, 1200)}`;
      })
      .join("\n\n");
    const summary = await callSummariser(harness, chunkText);
    if (!summary) continue;
    // Persist as a system message tagged with metadata so the panel UI
    // can show "summary of N messages, X days ago" and offer to drill
    // back into the originals.
    await sql`
      INSERT INTO messages (panel_id, role, content, tokens, metadata)
      VALUES (${panelId}::uuid, 'system', ${summary},
              ${Math.ceil(summary.length / 4)},
              ${sql.json({
                kind: "auto_summary",
                window_days: daysOld,
                chunk_size: chunk.length,
                source_message_ids: chunk.map((c) => c.id),
                created_by: "auto-summarize",
              })})
    `;
    summariesInserted++;
  }

  return {
    panel_id: panelId,
    window_days: daysOld,
    chunks,
    summaries_inserted: summariesInserted,
    source_messages: rows.length,
  };
}

async function callSummariser(harness: Harness, chunkText: string): Promise<string | null> {
  let assembled = "";
  try {
    const model = await pickDefaultModel(harness);
    for await (const c of harness.chat({
      model,
      messages: [
        { role: "system", content: SUMMARISE_PROMPT },
        { role: "user", content: chunkText },
      ],
      temperature: 0.2,
      maxTokens: 512,
    })) {
      if (c.done) break;
      if (c.delta) assembled += c.delta;
    }
  } catch (err) {
    console.warn("[auto-summarize] harness call failed:", (err as Error).message);
    return null;
  }
  const trimmed = assembled.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function pickDefaultModel(harness: Harness): Promise<string> {
  try {
    const list = await harness.listModels();
    if (list.length > 0) return list[0]!;
  } catch {
    /* fall through */
  }
  return "gpt-4o-mini";
}

// ───────────────────────────────────────────────────────────────────
// Nightly scheduler — walks every active panel that has old messages.
// ───────────────────────────────────────────────────────────────────

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startAutoSummarizeScheduler(): void {
  if (schedulerHandle) return;
  // Schedule for 03:30 local time, well clear of the preference learner
  // tick at midnight + 2 minutes.
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 30, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const delay = Math.max(60_000, target.getTime() - now.getTime());
  schedulerHandle = setTimeout(() => {
    void tick();
    schedulerHandle = setInterval(() => void tick(), ONE_DAY_MS);
  }, delay);
  console.log("✓ auto-summarize scheduler armed (next run in",
    Math.round(delay / 60_000), "min)");
}

export function stopAutoSummarizeScheduler(): void {
  if (schedulerHandle) {
    clearTimeout(schedulerHandle);
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

async function tick(): Promise<void> {
  try {
    // Find panels whose oldest message predates the cutoff. We use the
    // max(age) so a single ancient message in an otherwise-quiet panel
    // doesn't drag that panel in every night.
    const cutoff = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const panels = await sql<{ id: string; oldest: Date }[]>`
      SELECT panel_id AS id, min(created_at) AS oldest
      FROM messages
      WHERE panel_id IS NOT NULL
        AND created_at < ${cutoff.toISOString()}::timestamptz
        AND role IN ('user', 'assistant')
      GROUP BY panel_id
      HAVING count(*) >= ${CHUNK_SIZE}
    `;
    for (const p of panels) {
      await autoSummarizePanel(p.id, DEFAULT_WINDOW_DAYS).catch((err) =>
        console.warn("[auto-summarize] panel failed:", p.id, (err as Error).message),
      );
    }
    if (panels.length > 0) {
      console.log("✓ auto-summarize: processed", panels.length, "panels");
    }
  } catch (err) {
    console.warn("[auto-summarize] tick failed:", (err as Error).message);
  }
}
