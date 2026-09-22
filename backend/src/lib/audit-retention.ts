// Audit log retention.  Without this, audit_log grows unbounded.
// We keep `RETENTION_DAYS` days (default 90) and prune on a daily
// interval. The retention window is configurable so regulated
// environments can extend (SOC2 / ISO 27001 typically want 1 year).

import { sql } from "../db/client.ts";
import { rawConsole } from "../lib/log.ts";

const RETENTION_DAYS = Number(process.env.HELM_AUDIT_RETENTION_DAYS ?? 90);
let scheduled = false;

export function startAuditRetention(): void {
  if (scheduled) return;
  scheduled = true;
  const oneDay = 24 * 60 * 60 * 1000;
  // Run once at boot, then every RETENTION_DAYS / 12 (12x more often
  // than the retention window, so a long downtime doesn't pile up
  // unbounded work).
  const tick = async () => {
    try {
      const r = await sql<{ n: number }[]>`
        DELETE FROM audit_log
        WHERE created_at < now() - (${RETENTION_DAYS}::int * interval '1 day')
      `;
      const n = r[0]?.n ?? 0;
      if (n > 0) rawConsole.log(`[audit-retention] pruned ${n} old rows`);
    } catch (err) {
      rawConsole.warn("[audit-retention] prune failed:", (err as Error).message);
    }
  };
  void tick();
  setInterval(tick, Math.max(oneDay, RETENTION_DAYS * oneDay / 12)).unref();
  rawConsole.log(
    `[audit-retention] started (retention=${RETENTION_DAYS} days)`,
  );
}
