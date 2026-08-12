// Conversation summarization (Tier 4: Discovery).
//
// `summarizePanel(panel_id, days)` — collapses every message in a panel
// older than `days` into a single "system" message containing a compact
// summary. We keep the underlying rows (so audit + snapshots survive)
// but front-load the summary so the next agent turn sees a short
// history instead of replaying N weeks of chatter.
//
// Strategy:
//   1. Load all messages older than the cutoff for the panel (cap to
//      1000 rows so a runaway summarisation can't blow context).
//   2. Call the panel's assigned model (or the first model the caller
//      has access to) to summarise.
//   3. Insert a single 'system' row that records the summary plus the
//      count of collapsed rows. We do NOT delete the originals —
//      §2.3a preserves full history for audit, so collapsing happens
//      at the model-context layer, not the storage layer.

import { sql } from "../db/client.ts";
import { getProviderById, buildAdapter } from "../providers/registry.ts";

export interface SummarizeResult {
  ok: true;
  panelId: string;
  collapsed: number;
  summary: string;
}

interface PanelForSummary {
  id: string;
  name: string;
  agent_model_id: string | null;
  created_by: string | null;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  sender_name: string | null;
  created_at: Date;
}

/**
 * Run a summarisation pass for one panel. If the panel has fewer than
 * `minMessages` rows in the cutoff window we no-op — no value in
 * summarising an empty slice. The summary is also short-circuited when
 * no model is available.
 */
export async function summarizePanel(
  panelId: string,
  opts: { days: number; userId: string; isAdmin: boolean; minMessages?: number } = {
    days: 7,
    userId: "",
    isAdmin: false,
  },
): Promise<SummarizeResult | { ok: false; reason: string }> {
  const minMessages = opts.minMessages ?? 4;
  const panelRows = await sql<PanelForSummary[]>`
    SELECT id, name, agent_model_id, created_by FROM panels
    WHERE id = ${panelId}::uuid LIMIT 1
  `;
  const panel = panelRows[0];
  if (!panel) return { ok: false, reason: "not_found" };
  if (!opts.isAdmin && panel.created_by !== opts.userId) {
    // Confirm the user is a panel member before allowing summarisation.
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${panelId}::uuid AND user_id = ${opts.userId}::uuid LIMIT 1
    `;
    if (!m[0]) return { ok: false, reason: "forbidden" };
  }

  const cutoff = new Date(Date.now() - opts.days * 24 * 3600 * 1000);
  const messages = await sql<MessageRow[]>`
    SELECT m.id, m.role, m.content,
           u.name AS sender_name, m.created_at
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.panel_id = ${panelId}::uuid
      AND m.created_at < ${cutoff}
      AND m.role IN ('user','assistant')
    ORDER BY m.created_at ASC
    LIMIT 1000
  `;
  if (messages.length < minMessages) {
    return { ok: false, reason: "nothing_to_collapse" };
  }

  // Pick the summarisation model. Prefer the panel's assigned model;
  // fall back to the user's first assigned one; finally admin's
  // global fallback.
  let chosenModelId = panel.agent_model_id;
  let chosenProviderId: string | null = null;
  let chosenExternal: string | null = null;
  if (chosenModelId) {
    const rows = await sql<{ provider_id: string; external_id: string }[]>`
      SELECT provider_id, external_id FROM models WHERE id = ${chosenModelId}::uuid LIMIT 1
    `;
    if (rows[0]) {
      chosenProviderId = rows[0].provider_id;
      chosenExternal = rows[0].external_id;
    }
  }
  if (!chosenExternal) {
    const fallback = await sql<{
      id: string;
      external_id: string;
      provider_id: string;
    }[]>`
      SELECT m.id, m.external_id, m.provider_id FROM models m
      ${opts.isAdmin
        ? sql``
        : sql`JOIN model_access ma ON ma.model_id = m.id AND ma.user_id = ${opts.userId}::uuid`}
      WHERE m.state = 'active' ORDER BY m.created_at ASC LIMIT 1
    `;
    if (fallback[0]) {
      chosenModelId = fallback[0].id;
      chosenProviderId = fallback[0].provider_id;
      chosenExternal = fallback[0].external_id;
    }
  }
  if (!chosenExternal || !chosenProviderId) {
    return { ok: false, reason: "no_model_available" };
  }
  const provider = await getProviderById(chosenProviderId);
  if (!provider) return { ok: false, reason: "provider_missing" };
  const adapter = await buildAdapter(provider, { allowLocal: true });

  const excerpt = messages
    .map((m) => {
      const who = m.sender_name ?? m.role;
      const date = new Date(m.created_at).toISOString().slice(0, 10);
      return `[${date} ${who}]\n${m.content.slice(0, 800)}`;
    })
    .join("\n\n");

  const systemPrompt =
    "You compress long chat history into a short summary. Keep decisions, " +
    "open questions, and named entities (people, projects, files). Output " +
    "no more than ~12 short bullet points followed by a one-line 'Last update' " +
    "marker. Do not invent facts that are not in the transcript.";

  let assembled = "";
  for await (const chunk of adapter.chat({
    model: chosenExternal,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Summarise these ${messages.length} messages from panel "${panel.name}":\n\n${excerpt}` },
    ],
    temperature: 0.2,
    maxTokens: 600,
  })) {
    if (chunk.delta) assembled += chunk.delta;
  }
  const summary = assembled.trim() || "(no summary produced)";

  await sql`
    INSERT INTO messages (panel_id, user_id, role, content, tokens)
    VALUES (${panelId}::uuid, NULL, 'system',
            ${`[summary · ${messages.length} msgs collapsed · cutoff ${opts.days}d]\n\n${summary}`},
            ${Math.ceil(summary.length / 4)})
  `;
  return { ok: true, panelId, collapsed: messages.length, summary };
}
