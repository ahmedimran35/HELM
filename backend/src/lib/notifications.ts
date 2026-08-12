// Smart notifications (Tier 4: Discovery).
//
// One file, two responsibilities:
//   1. A scheduler that ticks every 60 s and inserts notifications for
//      user-meaningful events (budget caps, stale approvals, summaries
//      due, @-mentions). Dedup is per-user per-kind with a configurable
//      cool-off window so users don't get spammed.
//   2. CRUD helpers used by the `notifications` route file: list, mark
//      read, read-all, plus preferences listing and updating.
//
// Notification kinds:
//   budget_alert     — spend cap at/over threshold for the active period
//   approval_needed  — an approval request pending > 5 minutes
//   summary_due      — a panel/memory has not been summarised in 7 days
//   mention          — a message mentions the current user (@username)
//   general          — catch-all
//
// Priority defaults:
//   urgent — budget over hard cap, approval about to expire
//   high    — budget at warn threshold
//   normal  — approval pending, summary due
//   low     — mention
//
// Idempotent tick: each notification has a `dedup_key` derived from
// (user_id, kind, source_ref). We compute it cheaply and only INSERT
// if no row in the last DEDUP_MS window already has the same key.

import { sql } from "../db/client.ts";

export type NotificationKind =
  | "budget_alert"
  | "approval_needed"
  | "summary_due"
  | "mention"
  | "general";

export type NotificationPriority = "low" | "normal" | "high" | "urgent";

const TICK_MS = 60_000;
// 6 hours: long enough that repeat budget-threshold crossings don't spam
// the inbox, short enough that a real change still shows up.
const DEDUP_MS = 6 * 60 * 60 * 1000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

export function startNotificationScheduler(): void {
  if (schedulerHandle) return;
  // Fire once on boot so the inbox doesn't wait a minute after restart.
  void tick();
  schedulerHandle = setInterval(() => void tick(), TICK_MS);
  console.log("✓ notification scheduler started (tick =", TICK_MS, "ms)");
}

export function stopNotificationScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

interface InsertNotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string | null;
  priority?: NotificationPriority;
  sourceRef?: string;
}

async function insertNotification(input: InsertNotificationInput): Promise<boolean> {
  const dedupKey = `${input.userId}|${input.kind}|${input.sourceRef ?? "noref"}`;
  // Cheap dedup: only emit if no row with the same dedup key in the
  // DEDUP_MS window.
  const recent = await sql<{ id: string }[]>`
    SELECT id FROM notifications
    WHERE user_id = ${input.userId}::uuid
      AND dedup_key = ${dedupKey}
      AND created_at > now() - INTERVAL '6 hours'
    LIMIT 1
  `;
  if (recent.length > 0) return false;
  await sql`
    INSERT INTO notifications
      (user_id, kind, title, body, link, priority, dedup_key)
    VALUES
      (${input.userId}::uuid, ${input.kind},
       ${input.title}, ${input.body ?? ""},
       ${input.link ?? null}, ${input.priority ?? "normal"},
       ${dedupKey})
  `;
  return true;
}

async function tick(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await runBudgetAlerts();
    await runStaleApprovals();
    await runSummaryDue();
    await runMentions();
  } catch (err) {
    console.warn("[notifications] tick failed:", (err as Error).message);
  } finally {
    schedulerRunning = false;
  }
}

// Per-user spend threshold. If `spend_caps` has a row for a panel
// the user owns (or — admin — every panel) and current period spend
// ≥ warn_at_pct of the cap, emit.
async function runBudgetAlerts(): Promise<void> {
  // Most recent 7 days of harness_runs + audit tokens are an approximation
  // for "spend" — we don't have a dedicated token ledger per period yet,
  // so this stays advisory.
  const caps = await sql<{
    user_id: string;
    panel_id: string;
    period: string;
    limit_cents: number;
    warn_at_pct: number;
    hard_cap: boolean;
  }[]>`
    SELECT p.created_by AS user_id, sc.panel_id, sc.period,
           sc.limit_cents, sc.warn_at_pct, sc.hard_cap
    FROM spend_caps sc
    JOIN panels p ON p.id = sc.panel_id
    WHERE p.created_by IS NOT NULL
  `;
  if (caps.length === 0) return;
  for (const cap of caps) {
    // Sum tokens over the active window. Treat tokens as the proxy for
    // cents (we don't track cost directly). Don't emit if there's no
    // activity in the window.
    const sinceExpr =
      cap.period === "day"
        ? sql`now() - INTERVAL '1 day'`
        : cap.period === "week"
          ? sql`now() - INTERVAL '7 days'`
          : sql`date_trunc('month', now())`;
    const totals = await sql<{ n: number; tokens: number }[]>`
      SELECT count(*)::int AS n, COALESCE(sum(tokens), 0)::int AS tokens
      FROM messages
      WHERE panel_id = ${cap.panel_id}::uuid
        AND created_at >= ${sinceExpr}
    `;
    const tokens = totals[0]?.tokens ?? 0;
    if (tokens <= 0) continue;
    const tokenBudget = cap.limit_cents * 1000; // rough cents→tokens
    const pct = tokenBudget > 0 ? Math.round((tokens / tokenBudget) * 100) : 0;
    if (pct < cap.warn_at_pct) continue;
    await insertNotification({
      userId: cap.user_id,
      kind: "budget_alert",
      title: `Budget at ${pct}% (${cap.period})`,
      body: `Panel budget cap (${cap.limit_cents}¢, warn ${cap.warn_at_pct}%) is at ${pct}% of threshold for the current ${cap.period} period (${tokens} tokens).`,
      link: `/analytics`,
      priority: cap.hard_cap && pct >= 100 ? "urgent" : pct >= 100 ? "high" : "normal",
      sourceRef: `${cap.panel_id}-${cap.period}`,
    });
  }
}

async function runStaleApprovals(): Promise<void> {
  const stale = await sql<{
    id: string;
    user_id: string;
    panel_id: string | null;
    tool_name: string;
    created_at: Date;
  }[]>`
    SELECT id, user_id, panel_id, tool_name, created_at FROM approval_requests
    WHERE status = 'pending' AND created_at < now() - INTERVAL '5 minutes'
  `;
  for (const a of stale) {
    const link = a.panel_id ? `/panels?panel=${a.panel_id}` : "/requests";
    await insertNotification({
      userId: a.user_id,
      kind: "approval_needed",
      title: `${a.tool_name} awaiting approval`,
      body: `An approval request for ${a.tool_name} has been waiting > 5 minutes.`,
      link,
      priority: "normal",
      sourceRef: a.id,
    });
  }
}

async function runSummaryDue(): Promise<void> {
  // Emit a summary-due reminder for each panel whose last assistant
  // message is older than 7 days. Reuses the existing messages table —
  // no separate "last summary" column needed.
  const stale = await sql<{
    id: string;
    name: string;
    user_id: string | null;
    last_message: Date | null;
  }[]>`
    SELECT p.id, p.name, p.created_by AS user_id,
           (SELECT max(created_at) FROM messages m WHERE m.panel_id = p.id) AS last_message
    FROM panels p
  `;
  for (const p of stale) {
    if (!p.last_message) continue;
    const ageDays = (Date.now() - new Date(p.last_message).getTime()) / (24 * 3600 * 1000);
    if (ageDays < 7) continue;
    if (!p.user_id) continue;
    await insertNotification({
      userId: p.user_id,
      kind: "summary_due",
      title: `${p.name} is ready to summarise`,
      body: `No messages in this panel for ${Math.round(ageDays)} days. Run a summarise pass to compress history.`,
      link: `/panels?panel=${p.id}`,
      priority: "low",
      sourceRef: `${p.id}-summary`,
    });
  }
}

// Naive mention extraction: messages in panels the user is a member of
// containing `@username`. We index the user's username and @-mention it
// in panel messages.
async function runMentions(): Promise<void> {
  const users = await sql<{ id: string; username: string; name: string }[]>`
    SELECT id, username, name FROM users WHERE is_active = TRUE
  `;
  if (users.length === 0) return;
  for (const u of users) {
    const token = "@" + u.username.toLowerCase();
    const rows = await sql<{
      id: string;
      panel_id: string | null;
      content: string;
      created_at: Date;
    }[]>`
      SELECT id, panel_id, content, created_at FROM messages
      WHERE panel_id IS NOT NULL
        AND LOWER(content) LIKE ${"%" + token + "%"}
        AND created_at > now() - INTERVAL '6 hours'
        AND user_id <> ${u.id}::uuid
        AND panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${u.id}::uuid)
      ORDER BY created_at DESC LIMIT 5
    `;
    for (const r of rows) {
      await insertNotification({
        userId: u.id,
        kind: "mention",
        title: `Mentioned in a panel`,
        body: r.content.slice(0, 240),
        link: r.panel_id ? `/panels?panel=${r.panel_id}` : undefined,
        priority: "low",
        sourceRef: r.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers (consumed by the route file).
// ---------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  priority: NotificationPriority;
  read_at: Date | null;
  created_at: Date;
}

export interface NotificationPrefRow {
  id: string;
  kind: string;
  channel: "in_app" | "email" | "webhook";
  enabled: boolean;
  threshold: number | null;
}

export async function listNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ rows: NotificationRow[]; unread: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const rows = opts.unreadOnly
    ? await sql<NotificationRow[]>`
        SELECT id, kind, title, body, link, priority, read_at, created_at
        FROM notifications
        WHERE user_id = ${userId}::uuid AND read_at IS NULL
        ORDER BY created_at DESC LIMIT ${limit}
      `
    : await sql<NotificationRow[]>`
        SELECT id, kind, title, body, link, priority, read_at, created_at
        FROM notifications
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC LIMIT ${limit}
      `;
  const unreadRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications
    WHERE user_id = ${userId}::uuid AND read_at IS NULL
  `;
  return { rows, unread: unreadRows[0]?.n ?? 0 };
}

export async function markRead(userId: string, id: string): Promise<boolean> {
  const r = await sql`
    UPDATE notifications
    SET read_at = now()
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL
    RETURNING id
  `;
  return r.length > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const r = await sql<{ id: string }[]>`
    UPDATE notifications SET read_at = now()
    WHERE user_id = ${userId}::uuid AND read_at IS NULL
    RETURNING id
  `;
  return r.length;
}

export async function listPreferences(userId: string): Promise<NotificationPrefRow[]> {
  let rows = await sql<NotificationPrefRow[]>`
    SELECT id, kind, channel, enabled, threshold FROM notification_preferences
    WHERE user_id = ${userId}::uuid
    ORDER BY kind, channel
  `;
  if (rows.length === 0) {
    // Lazy-seed defaults so the UI always has a list to render.
    const kinds = ["budget_alert", "approval_needed", "summary_due", "mention"] as const;
    for (const kind of kinds) {
      await sql`
        INSERT INTO notification_preferences (user_id, kind, channel, enabled, threshold)
        VALUES (${userId}::uuid, ${kind}, 'in_app', TRUE, 80)
        ON CONFLICT (user_id, kind, channel) DO NOTHING
      `;
    }
    rows = await sql<NotificationPrefRow[]>`
      SELECT id, kind, channel, enabled, threshold FROM notification_preferences
      WHERE user_id = ${userId}::uuid
      ORDER BY kind, channel
    `;
  }
  return rows;
}

export async function updatePreference(
  userId: string,
  kind: string,
  channel: string,
  patch: { enabled?: boolean; threshold?: number | null },
): Promise<boolean> {
  if (channel !== "in_app" && channel !== "email" && channel !== "webhook") return false;
  const r = await sql`
    INSERT INTO notification_preferences (user_id, kind, channel, enabled, threshold)
    VALUES (${userId}::uuid, ${kind}, ${channel},
            ${patch.enabled ?? true}, ${patch.threshold ?? null})
    ON CONFLICT (user_id, kind, channel) DO UPDATE
      SET enabled = EXCLUDED.enabled, threshold = EXCLUDED.threshold
    RETURNING id
  `;
  return r.length > 0;
}

// ---------------------------------------------------------------------------
// Route — mounted under /api/notifications and /api/notification-preferences.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const user = c.get("user");
  const unreadOnly = c.req.query("unread") === "1";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const out = await listNotifications(user.id, { unreadOnly, limit });
  return c.json(out);
});

router.post("/:id/read", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ok = await markRead(user.id, id);
  return c.json({ ok });
});

router.post("/read-all", async (c) => {
  const user = c.get("user");
  const updated = await markAllRead(user.id);
  return c.json({ ok: true, updated });
});

export const notificationRouter = router;

// Preferences — sibling sub-app, mounted on /api/notification-preferences.
export const preferencesRouter = new Hono();
preferencesRouter.use("*", requireAuth);

preferencesRouter.get("/", async (c) => {
  const rows = await listPreferences(c.get("user").id);
  return c.json(rows);
});

preferencesRouter.patch("/:kind/:channel", async (c) => {
  const kind = c.req.param("kind");
  const channel = c.req.param("channel");
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    threshold?: number | null;
  };
  const ok = await updatePreference(c.get("user").id, kind, channel, {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    threshold: typeof body.threshold === "number" ? body.threshold : null,
  });
  if (!ok) return c.json({ error: "invalid_channel" }, 400);
  return c.json({ ok: true });
});
