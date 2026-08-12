// Per-panel spend caps (Tier 5).
//
// Wraps the `spend_caps` table with three operations the chat route
// and /api/spend-caps endpoints need:
//
//   - getCurrentSpend(panelId, period)  → cents spent in this period
//   - recordSpend(panelId, costCents)   → append, fire warn notification
//   - evaluateCap(panelId, costCents)   → { allowed, over_hard, ratio }
//
// Spend is derived from the `harness_runs` table (every model call
// already records prompt_tokens + completion_tokens + the model
// external id). We join through `models` to get the per-1k prices
// and compute cost in cents. Cached in-memory per panel+period for
// 30s so the chat hot path doesn't re-query on every turn.

import { sql } from "../db/client.ts";
import { logAudit } from "./audit.ts";

export type SpendPeriod = "day" | "week" | "month";

interface SpendCapRow {
  id: string;
  panel_id: string;
  period: SpendPeriod;
  limit_cents: number;
  warn_at_pct: number;
  hard_cap: boolean;
}

interface SpendSnapshot {
  panel_id: string;
  period: SpendPeriod;
  spent_cents: number;
  limit_cents: number;
  warn_at_pct: number;
  hard_cap: boolean;
  ratio: number;
  over_warn: boolean;
  over_limit: boolean;
}

const PERIOD_TRUNC: Record<SpendPeriod, string> = {
  day: "day",
  week: "week",
  month: "month",
};

interface CacheEntry {
  spent_cents: number;
  fetched_at: number;
}

const spendCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

const lastWarnKey = new Map<string, number>();

function cacheKey(panelId: string, period: SpendPeriod): string {
  return `${panelId}:${period}`;
}

/** Compute the start of the current period (UTC). Used by the SQL
 *  filter — kept inline so callers don't have to think about
 *  calendar arithmetic. */
function periodStartSql(period: SpendPeriod): string {
  return `date_trunc('${PERIOD_TRUNC[period]}', now())`;
}

interface SpendAggRow {
  spent: number;
}

async function loadSpentCents(
  panelId: string,
  period: SpendPeriod,
): Promise<number> {
  const key = cacheKey(panelId, period);
  const cached = spendCache.get(key);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return cached.spent_cents;
  }
  const rows = await sql<SpendAggRow[]>`
    SELECT COALESCE(SUM(
      CASE
        WHEN m.input_price_per_1k IS NULL OR m.output_price_per_1k IS NULL THEN
          -- Fallback: assume $0.001 / 1k = 0.1 cent / 1k, no distinction
          (hr.prompt_tokens + hr.completion_tokens) * 0.1 / 1000
        ELSE
          (hr.prompt_tokens  * m.input_price_per_1k +
           hr.completion_tokens * m.output_price_per_1k)
      END
    ), 0)::numeric(12, 4) AS spent
    FROM harness_runs hr
    LEFT JOIN models m ON m.external_id = hr.model
    WHERE hr.panel_id = ${panelId}::uuid
      AND hr.status = 'ok'
      AND hr.created_at >= ${sql.unsafe(periodStartSql(period))}
  `;
  const cents = Number(rows[0]?.spent ?? 0);
  spendCache.set(key, { spent_cents: cents, fetched_at: Date.now() });
  return cents;
}

export async function getCap(
  panelId: string,
  period: SpendPeriod,
): Promise<SpendCapRow | null> {
  const rows = await sql<SpendCapRow[]>`
    SELECT id, panel_id, period, limit_cents, warn_at_pct, hard_cap
    FROM spend_caps
    WHERE panel_id = ${panelId}::uuid AND period = ${period}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getCurrentSpend(
  panelId: string,
  period: SpendPeriod,
): Promise<SpendSnapshot> {
  const cap = await getCap(panelId, period);
  const spent = await loadSpentCents(panelId, period);
  const limit = cap?.limit_cents ?? 0;
  const ratio = limit > 0 ? spent / limit : 0;
  return {
    panel_id: panelId,
    period,
    spent_cents: spent,
    limit_cents: limit,
    warn_at_pct: cap?.warn_at_pct ?? 80,
    hard_cap: cap?.hard_cap ?? false,
    ratio,
    over_warn: limit > 0 && ratio * 100 >= (cap?.warn_at_pct ?? 80),
    over_limit: limit > 0 && spent >= limit,
  };
}

/** Decide whether a new chat turn (with `additionalCostCents`) is
 *  allowed under the cap. Returns:
 *    - allowed: false  → caller must reject with `budget_exceeded`
 *    - over_warn: true → caller may want to show a soft warning
 *    - ratio: 0..N     → for UI progress bars */
export async function evaluateCap(
  panelId: string,
  period: SpendPeriod,
  additionalCostCents: number,
): Promise<{ allowed: boolean; snapshot: SpendSnapshot }> {
  const snap = await getCurrentSpend(panelId, period);
  const projected = snap.spent_cents + additionalCostCents;
  const projectedRatio = snap.limit_cents > 0 ? projected / snap.limit_cents : 0;
  if (snap.hard_cap && snap.limit_cents > 0 && projected > snap.limit_cents) {
    return {
      allowed: false,
      snapshot: { ...snap, ratio: projectedRatio, over_limit: true },
    };
  }
  return {
    allowed: true,
    snapshot: { ...snap, ratio: projectedRatio },
  };
}

/** Record a spend event. Bumps the cache immediately so the next
 *  call sees the new total without re-querying. Fires a warn
 *  notification if crossing the warn threshold (deduped per period
 *  so a chat storm doesn't spam). */
export async function recordSpend(
  panelId: string,
  userId: string,
  costCents: number,
  period: SpendPeriod = "month",
): Promise<void> {
  if (!Number.isFinite(costCents) || costCents <= 0) return;

  // Bump the in-memory cache directly so the next call sees the
  // increment immediately. We don't write a spend ledger — we
  // derive spend from harness_runs on cache miss instead.
  const key = cacheKey(panelId, period);
  const cached = spendCache.get(key);
  if (cached) {
    spendCache.set(key, {
      spent_cents: cached.spent_cents + costCents,
      fetched_at: cached.fetched_at,
    });
  }

  // Check the cap and possibly fire a warn notification.
  try {
    const snap = await getCurrentSpend(panelId, period);
    if (snap.limit_cents <= 0) return;
    const ratio = snap.spent_cents / snap.limit_cents;
    if (ratio * 100 < snap.warn_at_pct) return;
    // Dedup: only fire once per (panel, period) per 6 hours.
    const dedupKey = `${key}:${snap.warn_at_pct}`;
    const lastFired = lastWarnKey.get(dedupKey) ?? 0;
    if (Date.now() - lastFired < 6 * 60 * 60 * 1000) return;
    lastWarnKey.set(dedupKey, Date.now());

    await sql`
      INSERT INTO notifications (user_id, kind, title, body, link, priority)
      VALUES (
        ${userId}::uuid,
        'budget_alert',
        ${`Spend at ${(ratio * 100).toFixed(0)}% of cap`},
        ${`Panel has used ${snap.spent_cents.toFixed(2)} of ${snap.limit_cents.toFixed(2)} cents this ${period}.`},
        ${`/spend-caps`},
        ${ratio >= 1 ? "urgent" : "high"}
      )
    `;
    await logAudit({
      userId,
      target: panelId,
      action: "spend_cap_warn",
      metadata: { period, ratio, spent_cents: snap.spent_cents, limit_cents: snap.limit_cents },
    });
  } catch (err) {
    console.warn("[spend-tracker] warn notify failed:", (err as Error).message);
  }
}

export interface SpendCapsListRow extends SpendSnapshot {
  panel_name: string;
}

/** All spend-cap rows visible to a user (their own panels + shared
 *  panels they belong to). Admins see all. */
export async function listSpendCapsForUser(
  userId: string,
  isAdmin: boolean,
): Promise<SpendCapsListRow[]> {
  const capRows = isAdmin
    ? await sql<(SpendCapRow & { panel_name: string })[]>`
        SELECT sc.id, sc.panel_id, sc.period, sc.limit_cents,
               sc.warn_at_pct, sc.hard_cap,
               p.name AS panel_name
        FROM spend_caps sc
        JOIN panels p ON p.id = sc.panel_id
        ORDER BY p.name ASC
      `
    : await sql<(SpendCapRow & { panel_name: string })[]>`
        SELECT sc.id, sc.panel_id, sc.period, sc.limit_cents,
               sc.warn_at_pct, sc.hard_cap,
               p.name AS panel_name
        FROM spend_caps sc
        JOIN panels p ON p.id = sc.panel_id
        JOIN panel_members pm ON pm.panel_id = sc.panel_id
        WHERE pm.user_id = ${userId}::uuid
        ORDER BY p.name ASC
      `;
  const out: SpendCapsListRow[] = [];
  for (const r of capRows) {
    const spent = await loadSpentCents(r.panel_id, r.period as SpendPeriod);
    const ratio = r.limit_cents > 0 ? spent / r.limit_cents : 0;
    out.push({
      panel_id: r.panel_id,
      panel_name: r.panel_name,
      period: r.period as SpendPeriod,
      spent_cents: spent,
      limit_cents: r.limit_cents,
      warn_at_pct: r.warn_at_pct,
      hard_cap: r.hard_cap,
      ratio,
      over_warn: r.limit_cents > 0 && ratio * 100 >= r.warn_at_pct,
      over_limit: r.limit_cents > 0 && spent >= r.limit_cents,
    });
  }
  return out;
}

/** Upsert a spend cap. Allowed to anyone with admin role OR a panel
 *  membership — non-admin panel members can adjust their own panel's
 *  cap (useful for shared panels). */
export async function upsertSpendCap(input: {
  panelId: string;
  userId: string;
  isAdmin: boolean;
  period: SpendPeriod;
  limit_cents: number;
  warn_at_pct: number;
  hard_cap: boolean;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input.isAdmin) {
    const rows = await sql<{ panel_id: string }[]>`
      SELECT panel_id FROM panel_members
      WHERE user_id = ${input.userId}::uuid AND panel_id = ${input.panelId}::uuid
      LIMIT 1
    `;
    if (!rows[0]) return { ok: false, reason: "not_panel_member" };
  }
  await sql`
    INSERT INTO spend_caps (panel_id, period, limit_cents, warn_at_pct, hard_cap)
    VALUES (${input.panelId}::uuid, ${input.period}, ${input.limit_cents},
            ${input.warn_at_pct}, ${input.hard_cap})
    ON CONFLICT (panel_id, period) DO UPDATE
      SET limit_cents = EXCLUDED.limit_cents,
          warn_at_pct = EXCLUDED.warn_at_pct,
          hard_cap = EXCLUDED.hard_cap,
          updated_at = now()
  `;
  await logAudit({
    userId: input.userId,
    target: input.panelId,
    action: "spend_cap_set",
    metadata: {
      period: input.period,
      limit_cents: input.limit_cents,
      warn_at_pct: input.warn_at_pct,
      hard_cap: input.hard_cap,
    },
  });
  // Invalidate the spend cache for this panel+period.
  spendCache.delete(cacheKey(input.panelId, input.period));
  return { ok: true };
}