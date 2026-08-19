// CSP violation report endpoint.
//
// `Content-Security-Policy-Report-Only` (and the strict `Content-Security-Policy`
// when augmented with `report-uri /api/csp-report`) cause browsers to POST
// `{ "csp-report": { ... } }` to this endpoint whenever the page tries to
// violate the policy. We don't authenticate this endpoint — anyone can
// cause a report to be sent — because the spec requires the browser to
// be able to report violations from any origin, including same-origin
// pages that may themselves be hostile. We DO limit the body size and
// we DO sanitise the payload before logging.
//
// Reference: https://www.w3.org/TR/CSP3/#violation-reports

import { Hono } from "hono";
import { logSecurityEvent } from "../lib/security-events.ts";

const router = new Hono();
// Hard cap on body size. A CSP report is supposed to be a small JSON
// document (~1 KB); anything bigger is hostile.
const MAX_BODY_BYTES = 8 * 1024;

router.post("/", async (c) => {
  // Read the raw body so we can refuse oversized payloads before
  // parsing them. JSON.parse on a 50 MB blob is itself a DoS vector.
  const raw = await c.req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return c.text("payload too large", 413);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Browsers always send JSON; if we can't parse it, just log a
    // generic event and return 204 (so the browser doesn't retry).
    logSecurityEvent({
      type: "csp_violation",
      severity: "warn",
      route: "/api/csp-report",
      details: { parse_error: "true" },
      ts: Date.now(),
    });
    return c.body(null, 204);
  }
  const report = (body["csp-report"] as Record<string, unknown> | undefined) ?? body;
  // Pick out the fields the operator actually wants to see. Don't
  // echo the entire violation payload — some of it (originalRequest,
  // sample) can contain attacker-controlled strings. Just summarise.
  const details: Record<string, string | number | boolean> = {
    blocked_uri: String(report["blocked-uri"] ?? "").slice(0, 200),
    violated_directive: String(report["violated-directive"] ?? report["effective-directive"] ?? "").slice(0, 200),
    document_uri: String(report["document-uri"] ?? "").slice(0, 200),
    disposition: String(report["disposition"] ?? "").slice(0, 50),
  };
  if (typeof report["line-number"] === "number") {
    details.line_number = report["line-number"];
  }
  if (typeof report["column-number"] === "number") {
    details.column_number = report["column-number"];
  }
  logSecurityEvent({
    type: "csp_violation",
    severity: "warn",
    route: "/api/csp-report",
    details,
    ts: Date.now(),
  });
  // 204 — the browser doesn't need the body. Returning a body would
  // waste bytes on every violation.
  return c.body(null, 204);
});

export default router;