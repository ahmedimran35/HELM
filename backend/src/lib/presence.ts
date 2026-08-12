// Live presence service for multiplayer panels (Tier 1 co-pilot).
//
// Backed by the `panel_presence` table. Rows are upserted on every
// status change and expire after `thresholdMs` of inactivity. The WebSocket
// layer calls `setPresence` from each connected client and then calls
// `broadcast` to fan out the new state to everyone in the room.
//
// The store is intentionally tiny — one write per status change per user.
// Reads are served from a per-process cache that mirrors the SQL truth
// so the REST endpoint `/api/panels/:id/presence` is cheap for late
// joiners.

import { sql } from "../db/client.ts";

export type PresenceStatus = "viewing" | "typing" | "idle";

export interface PresenceEntry {
  user_id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  status: PresenceStatus;
  cursor_block: string | null;
  last_seen_at: string; // ISO
}

// Default staleness threshold. Anything older than this is treated as
// gone (so the UI doesn't display a teammate who navigated away).
export const DEFAULT_STALE_MS = 60_000;

export async function setPresence(
  panelId: string,
  userId: string,
  status: PresenceStatus,
  cursorBlock?: string | null,
): Promise<PresenceEntry | null> {
  // Upsert: row exists per (panel_id, user_id). Use the user's current
  // profile so the wire payload includes name/role for the UI.
  const rows = await sql<PresenceEntry[]>`
    WITH up AS (
      INSERT INTO panel_presence (panel_id, user_id, status, cursor_block, last_seen_at)
      VALUES (${panelId}::uuid, ${userId}::uuid, ${status},
              ${cursorBlock ?? null}, now())
      ON CONFLICT (panel_id, user_id) DO UPDATE
        SET status = EXCLUDED.status,
            cursor_block = EXCLUDED.cursor_block,
            last_seen_at = EXCLUDED.last_seen_at
      RETURNING panel_id, user_id, status, cursor_block, last_seen_at
    )
    SELECT up.user_id, u.username, u.name, u.role,
           up.status, up.cursor_block,
           up.last_seen_at::text AS last_seen_at
    FROM up
    JOIN users u ON u.id = up.user_id::uuid
  `;
  return rows[0] ?? null;
}

export async function clearPresence(
  panelId: string,
  userId: string,
): Promise<void> {
  await sql`
    DELETE FROM panel_presence
    WHERE panel_id = ${panelId}::uuid AND user_id = ${userId}::uuid
  `;
}

export async function getPresence(
  panelId: string,
  thresholdMs: number = DEFAULT_STALE_MS,
): Promise<PresenceEntry[]> {
  const rows = await sql<PresenceEntry[]>`
    SELECT pp.user_id, u.username, u.name, u.role,
           pp.status, pp.cursor_block,
           pp.last_seen_at::text AS last_seen_at
    FROM panel_presence pp
    JOIN users u ON u.id = pp.user_id::uuid
    WHERE pp.panel_id = ${panelId}::uuid
      AND pp.last_seen_at > now() - (${thresholdMs}::text || ' milliseconds')::interval
    ORDER BY pp.last_seen_at DESC
  `;
  return rows;
}

export async function pruneStale(thresholdMs: number = DEFAULT_STALE_MS): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    WITH stale AS (
      DELETE FROM panel_presence
      WHERE last_seen_at < now() - (${thresholdMs}::text || ' milliseconds')::interval
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM stale
  `;
  return rows[0]?.count ?? 0;
}