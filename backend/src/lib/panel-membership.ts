// Panel-membership helpers. Centralised so every route uses the
// same SQL pattern + the same "not_found_or_not_member" error shape.
//
// One file. Eight callers. Single audit point.

import { sql } from "../db/client.ts";

/** Returns true iff `userId` is a member of `panelId` (or admin). */
export async function isPanelMember(
  userId: string,
  panelId: string,
  isAdmin = false,
): Promise<boolean> {
  if (isAdmin) return true;
  const r = await sql<{ exists: number }[]>`
    SELECT EXISTS (
      SELECT 1 FROM panel_members
      WHERE panel_id = ${panelId}::uuid
        AND user_id = ${userId}::uuid
    )::int AS exists
  `;
  return (r[0]?.exists ?? 0) > 0;
}

/**
 * Returns the panel_ids the user is a member of. Used for IN-clause
 * scoping on queries that aggregate across panels (combo/spend-caps,
 * search, chat, skills).
 */
export async function userPanelIds(
  userId: string,
  isAdmin = false,
): Promise<string[]> {
  if (isAdmin) {
    const r = await sql<{ id: string }[]>`SELECT id FROM panels`;
    return r.map((x) => x.id);
  }
  const r = await sql<{ panel_id: string }[]>`
    SELECT panel_id FROM panel_members WHERE user_id = ${userId}::uuid
  `;
  return r.map((x) => x.panel_id);
}
