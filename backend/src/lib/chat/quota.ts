// User-message quota enforcement (docs §2.6).
//
// Quota enforcement for the 1:1 chat route: if the user has a quota row
// with a `message_limit` set, we increment-and-check atomically. If the
// limit is reached, we return `{ ok: false }` BEFORE issuing the upstream
// call. Budget enforcement is best-effort (we record tokens after the
// call finishes; alerting-only, not a hard block, per docs §2.6 wording).

import { sql } from "../../db/client.ts";

interface QuotaRow {
  message_limit: number | null;
}

// Sentinel error used to roll back the quota-check transaction without
// surfacing as a real error to the caller.
const QUOTA_EXCEEDED = Symbol("quota_exceeded");

// Atomically check the user's monthly quota AND insert the new user
// message in a single transaction. Returns { ok: true } when the message
// has been persisted and the request may proceed; { ok: false } when the
// quota is exceeded (the INSERT is rolled back so the count stays
// accurate).
//
// Why this is one transaction:
//   - The previous version read the count and then did a separate
//     INSERT. Two concurrent requests at the boundary could both pass
//     the check before either incremented, letting users blow past
//     their limit.
//   - We serialise quota decisions for a single user with an advisory
//     transaction lock keyed on the user id. Different users still run
//     in parallel.
//   - We count AFTER the insert so the current request is included in
//     the count; if the resulting count is over the limit we throw to
//     roll back the insert.
async function checkQuotaAndInsertUserMessage(
  userId: string,
  modelId: string | null,
  content: string,
  panelId?: string,
): Promise<{ ok: true } | { ok: false }> {
  return await sql
    .begin(async (tx) => {
      // Serialise concurrent quota checks for this user. hashtext is
      // stable within a single Postgres install; using the two-int form
      // avoids any bigint/int4 ambiguity in the tagged-template call.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}::text), 0)`;
      const qrows = await tx<QuotaRow[]>`SELECT message_limit FROM quotas WHERE user_id = ${userId}::uuid LIMIT 1`;
      const limit = qrows[0]?.message_limit ?? null;
      if (limit === null) {
        // No quota row → unlimited. Insert and commit.
        await tx`
          INSERT INTO messages (user_id, model_id, panel_id, role, content, tokens)
          VALUES (${userId}::uuid, ${modelId}::uuid, ${panelId ?? null}::uuid, 'user', ${content}, 0)
        `;
        return { ok: true } as const;
      }
      // Insert first, then count. Each chat turn produces two rows in
      // messages (user + assistant); only count the user row so the
      // limit maps 1:1 to turns, not halves the effective budget.
      await tx`
        INSERT INTO messages (user_id, model_id, panel_id, role, content, tokens)
        VALUES (${userId}::uuid, ${modelId}::uuid, ${panelId ?? null}::uuid, 'user', ${content}, 0)
      `;
      const countRows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM messages
        WHERE user_id = ${userId}::uuid
          AND role = 'user'
          AND created_at >= date_trunc('month', now())
      `;
      if ((countRows[0]?.n ?? 0) > limit) {
        // Throwing inside sql.begin rolls the transaction back, undoing
        // the INSERT above so the count remains accurate.
        throw QUOTA_EXCEEDED;
      }
      return { ok: true } as const;
    })
    .catch((err) => {
      if (err === QUOTA_EXCEEDED) return { ok: false } as const;
      throw err;
    });
}

// Public wrapper so other modules (ws.ts panel chat) can share the same
// quota enforcement as the HTTP /api/chat route. Without this, a user
// could bypass their monthly message budget by talking to the panel
// agent via the WebSocket instead of the HTTP route.
export async function enforceUserMessageQuota(
  userId: string,
  content: string,
  opts: { modelId?: string; panelId?: string } = {},
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return await checkQuotaAndInsertUserMessage(
    userId,
    opts.modelId ?? null,
    content,
    opts.panelId,
  );
}