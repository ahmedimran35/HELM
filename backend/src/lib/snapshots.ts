// Time-travel snapshots (Tier 1 co-pilot).
//
// After every assistant message we copy the current panel state
// (messages + persona + agent model + members count) into
// `session_snapshots.state`. The replay route serves these back so
// users can scrub or branch the conversation from any past turn.
//
// We deliberately don't store knowledge chunks or memory — those are
// already queryable separately and would balloon the jsonb size. The
// snapshot is just enough to "rehydrate" a panel.

import { sql } from "../db/client.ts";

interface SnapshotMessage {
  id: string;
  role: string;
  content: string;
  user_id: string | null;
  model_id: string | null;
  tokens: number;
  created_at: string;
  sender_name: string | null;
}

export interface PanelSnapshotState {
  panel_id: string;
  panel_name: string;
  agent_model_id: string | null;
  agent_model_name: string | null;
  persona_id: string | null;
  persona_name: string | null;
  member_count: number;
  messages: SnapshotMessage[];
}

export interface PanelSnapshotRow {
  id: string;
  panel_id: string;
  message_id: string;
  user_id: string;
  state: PanelSnapshotState;
  label: string | null;
  created_at: string;
}

export async function takePanelSnapshot(opts: {
  panelId: string;
  messageId: string;
  userId: string;
  label?: string | null;
}): Promise<string | null> {
  // Pull the panel meta + every message in chronological order.
  const meta = await sql<{
    panel_name: string;
    agent_model_id: string | null;
    agent_model_name: string | null;
    persona_id: string | null;
    persona_name: string | null;
    member_count: number;
  }[]>`
    SELECT p.name AS panel_name, p.agent_model_id, p.persona_id,
           md.display_name AS agent_model_name,
           pe.name AS persona_name,
           (SELECT count(*) FROM panel_members WHERE panel_id = p.id)::int AS member_count
    FROM panels p
    LEFT JOIN models md ON md.id = p.agent_model_id
    LEFT JOIN personas pe ON pe.id = p.persona_id
    WHERE p.id = ${opts.panelId}::uuid
    LIMIT 1
  `;
  const m = meta[0];
  if (!m) return null;

  const msgRows = await sql<SnapshotMessage[]>`
    SELECT m.id, m.role, m.content, m.user_id, m.model_id, m.tokens,
           m.created_at::text AS created_at,
           u.name AS sender_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.panel_id = ${opts.panelId}::uuid
    ORDER BY m.created_at ASC, m.id ASC
  `;

  const state: PanelSnapshotState = {
    panel_id: opts.panelId,
    panel_name: m.panel_name,
    agent_model_id: m.agent_model_id,
    agent_model_name: m.agent_model_name,
    persona_id: m.persona_id,
    persona_name: m.persona_name,
    member_count: m.member_count,
    messages: msgRows,
  };

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO session_snapshots (panel_id, message_id, user_id, state, label)
    VALUES (${opts.panelId}::uuid, ${opts.messageId}::uuid, ${opts.userId}::uuid,
            ${sql.json(state as never)}, ${opts.label ?? null})
    RETURNING id
  `;
  return inserted[0]?.id ?? null;
}

export async function listSnapshots(panelId: string): Promise<PanelSnapshotRow[]> {
  const rows = await sql<{
    id: string;
    panel_id: string;
    message_id: string;
    user_id: string;
    state: PanelSnapshotState;
    label: string | null;
    created_at: string;
  }[]>`
    SELECT id, panel_id, message_id, user_id, state, label,
           created_at::text AS created_at
    FROM session_snapshots
    WHERE panel_id = ${panelId}::uuid
    ORDER BY created_at ASC, id ASC
  `;
  return rows;
}

export async function getSnapshotsFrom(
  panelId: string,
  fromMessageId: string,
): Promise<PanelSnapshotRow[]> {
  const rows = await sql<{
    id: string;
    panel_id: string;
    message_id: string;
    user_id: string;
    state: PanelSnapshotState;
    label: string | null;
    created_at: string;
    anchor_created_at: string;
  }[]>`
    WITH anchor AS (
      SELECT created_at FROM messages
      WHERE id = ${fromMessageId}::uuid LIMIT 1
    )
    SELECT s.id, s.panel_id, s.message_id, s.user_id, s.state, s.label,
           s.created_at::text AS created_at,
           a.created_at::text AS anchor_created_at
    FROM session_snapshots s, anchor a
    WHERE s.panel_id = ${panelId}::uuid
      AND s.created_at >= a.created_at
    ORDER BY s.created_at ASC, s.id ASC
  `;
  return rows.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { anchor_created_at, ...rest } = r;
    return rest;
  });
}