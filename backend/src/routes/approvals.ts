// Inline approval gates (Tier 1 co-pilot).
//
// When the agent wants to call a "dangerous" tool (file delete, public
// post, email send, etc.) it pauses and emits an `approval_requests`
// row. The human user opens /approvals (or the inline overlay in the
// panel) and clicks Approve / Deny. The chat route checks the row's
// status before continuing the agent's tool call.
//
// v1 of this system stores requests and lets the UI surface them. The
// chat-side polling hook lives in `routes/chat.ts`; it watches any
// pending request tied to the current user and resumes when the row
// is approved. For Tier 1 the storage + UI is enough — Tier 7 wires
// it into the harness.
//
// Background sweeper: every 60 seconds we expire pending requests
// whose `expires_at` has passed. Started from `index.ts`.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

interface ApprovalRow {
  id: string;
  user_id: string;
  panel_id: string | null;
  tool_name: string;
  tool_args: Record<string, unknown>;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
}

const ALLOWED_STATUSES: ReadonlyArray<ApprovalRow["status"]> = [
  "pending",
  "approved",
  "denied",
  "expired",
];

function serialize(row: ApprovalRow) {
  return {
    ...row,
    // The frontend renders timestamps via Date; ship ISO strings so
    // JSON.parse on the wire gives a real ISO string instead of a date.
    expires_at: row.expires_at,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

router.get("/", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") ?? "pending";
  if (!ALLOWED_STATUSES.includes(status as ApprovalRow["status"])) {
    return c.json({ error: "invalid_status" }, 400);
  }
  const rows = await sql<ApprovalRow[]>`
    SELECT id, user_id, panel_id, tool_name, tool_args, reason, status,
           decided_by, decided_at::text AS decided_at,
           expires_at::text AS expires_at,
           created_at::text AS created_at
    FROM approval_requests
    WHERE user_id = ${user.id}::uuid AND status = ${status}
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return c.json(rows.map(serialize));
});

router.post("/", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    panel_id?: string;
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    reason?: string;
    auto_expire_minutes?: number;
  };
  const toolName = (body.tool_name ?? "").trim();
  if (!toolName) return c.json({ error: "tool_name required" }, 400);
  const args = body.tool_args ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return c.json({ error: "tool_args must be an object" }, 400);
  }
  const reason = (body.reason ?? "").trim() || null;
  const minutes = Math.max(
    1,
    Math.min(60 * 24, Math.floor(body.auto_expire_minutes ?? 15)),
  );

  const rows = await sql<ApprovalRow[]>`
    INSERT INTO approval_requests
      (user_id, panel_id, tool_name, tool_args, reason,
       expires_at)
    VALUES
      (${user.id}::uuid,
       ${body.panel_id ?? null}::uuid,
       ${toolName},
       ${sql.json(args as never)},
       ${reason},
       now() + (${minutes}::text || ' minutes')::interval)
    RETURNING id, user_id, panel_id, tool_name, tool_args, reason, status,
              decided_by, decided_at::text AS decided_at,
              expires_at::text AS expires_at,
              created_at::text AS created_at
  `;
  const row = rows[0]!;
  await logAudit({
    userId: user.id,
    target: row.id,
    action: "approval_requested",
    metadata: {
      tool: toolName,
      panel_id: body.panel_id ?? null,
      expires_in_minutes: minutes,
    },
  });
  return c.json(serialize(row));
});

router.post("/:id/decide", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: string;
  };
  const decision = body.decision;
  if (decision !== "approved" && decision !== "denied") {
    return c.json({ error: "decision must be approved or denied" }, 400);
  }
  // Only the user who owns the request (or an admin) can decide it.
  const target = await sql<{ user_id: string; status: ApprovalRow["status"] }[]>`
    SELECT user_id, status FROM approval_requests
    WHERE id = ${id}::uuid LIMIT 1
  `;
  const t = target[0];
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.user_id !== user.id && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  if (t.status !== "pending") {
    return c.json({ error: "already_decided", status: t.status }, 409);
  }
  const rows = await sql<ApprovalRow[]>`
    UPDATE approval_requests
    SET status = ${decision},
        decided_by = ${user.id}::uuid,
        decided_at = now()
    WHERE id = ${id}::uuid
    RETURNING id, user_id, panel_id, tool_name, tool_args, reason, status,
              decided_by, decided_at::text AS decided_at,
              expires_at::text AS expires_at,
              created_at::text AS created_at
  `;
  await logAudit({
    userId: user.id,
    target: id,
    action: `approval_${decision}`,
  });
  return c.json(serialize(rows[0]!));
});

// Sweeper — exported so index.ts can call it once at boot. Runs every
// 60s and flips any pending rows whose expires_at has passed to
// 'expired'. Best-effort: failures are logged, never thrown.
export async function sweepExpiredApprovals(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    WITH exp AS (
      UPDATE approval_requests
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM exp
  `;
  return rows[0]?.count ?? 0;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startApprovalSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepExpiredApprovals().catch((err) =>
      console.warn("approval sweep failed:", (err as Error).message),
    );
  }, 60_000);
}
export function stopApprovalSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export default router;