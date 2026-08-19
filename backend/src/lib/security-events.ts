// Structured security-event logger.
//
// Every security-relevant signal in the backend (failed logins, rate
// limits, SSRF blocks, oversized uploads, CSP violations, suspected
// session hijack, etc) calls `logSecurityEvent(...)`. The function does
// two things in parallel:
//
//   1. Emit a single-line JSON record on stdout for log aggregation
//      (Datadog / Loki / CloudWatch / Vector all pick up
//      `level=security_event`).
//   2. Fire-and-forget a Slack/PagerDuty/Discord webhook for any
//      warn/critical event via `fireAlert` (lib/alerts.ts) so the
//      operator gets paged in real time.
//
// Severity ladder:
//   - info      — routine signal worth recording (e.g. successful
//                 audit-log download). Never paged.
//   - warn      — notable but expected under attack pressure (single
//                 failed login, single 429, single SSRF block).
//                 Paged only if the operator set
//                 HELM_ALERT_MIN_SEVERITY=warn.
//   - critical  — emergency (account lockout, session hijack suspect).
//                 Always paged.
//
// Keep this module zero-dep beyond `alerts.ts` and `console` — the
// whole point is that the logger never goes down. If it imports
// something exotic, a bug in *that* dependency can blind us during
// the exact moment we need it.

import { fireAlert } from "./alerts.ts";

export type SecurityEventType =
  | "csp_violation"
  | "auth_failure"
  | "account_lockout"
  | "rate_limit_hit"
  | "idor_attempt"
  | "large_upload"
  | "suspicious_payload"
  | "ssrf_block"
  | "session_hijack_suspect";

export interface SecurityEvent {
  type: SecurityEventType;
  severity: "info" | "warn" | "critical";
  userId?: string;
  ip?: string;
  route?: string;
  details?: Record<string, string | number | boolean>;
  ts: number;
}

export function logSecurityEvent(e: SecurityEvent): void {
  // 1. Structured JSON log — one line per event for log aggregation.
  try {
    const payload = {
      level: "security_event",
      type: e.type,
      severity: e.severity,
      user_id: e.userId ?? null,
      ip: e.ip ?? null,
      route: e.route ?? null,
      details: e.details ?? null,
      ts: new Date(e.ts).toISOString(),
    };
    // toString() inside console.log is what most log shippers grep on;
    // using JSON.stringify directly keeps the format stable.
    console.log(JSON.stringify(payload));
  } catch (err) {
    // Last-ditch — never throw from the logger.
    console.warn("[security-events] log write failed:", (err as Error).message);
  }
  // 2. Fire-and-forget Slack alert for warn/critical.
  if (e.severity !== "info") {
    try {
      fireAlert({
        severity: e.severity,
        title: `Security: ${e.type}`,
        body: e.details ? JSON.stringify(e.details) : "no details",
        fields: [
          ...(e.userId ? [{ name: "user", value: e.userId }] : []),
          ...(e.ip ? [{ name: "ip", value: e.ip }] : []),
          ...(e.route ? [{ name: "route", value: e.route }] : []),
        ],
      });
    } catch (err) {
      console.warn("[security-events] alert fire failed:", (err as Error).message);
    }
  }
}