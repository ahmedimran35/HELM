// Real-time alerting via Slack-compatible incoming webhooks.
//
// Configure via env:
//   HELM_ALERT_WEBHOOK_URL  — full URL of the incoming-webhook
//                             (e.g. https://hooks.slack.com/services/.../...
//                              for Slack; for PagerDuty / Discord / Mattermost
//                              / custom, set the equivalent URL)
//   HELM_ALERT_MIN_SEVERITY  — "info" | "warn" | "critical" (default: warn)
//
// On critical events (account lockout, SSRF attempt, model_access
// escalation, etc.) we POST a JSON payload to the configured URL. The
// call is fire-and-forget with a 5s timeout so a slow / down alert
// receiver never blocks the request handler. Failures are logged.

interface AlertPayload {
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  fields?: Array<{ name: string; value: string }>;
}

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 } as const;

function shouldSend(severity: AlertPayload["severity"]): boolean {
  const minSev = (process.env.HELM_ALERT_MIN_SEVERITY as keyof typeof SEVERITY_RANK | undefined) ?? "warn";
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSev];
}

export function fireAlert(payload: AlertPayload): void {
  if (!shouldSend(payload.severity)) return;
  const url = process.env.HELM_ALERT_WEBHOOK_URL;
  if (!url) return; // No alert receiver configured — silent no-op.
  // Fire-and-forget. We don't await; the caller (e.g. a login handler)
  // returns to the user without waiting for the webhook to deliver.
  void (async () => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `*[${payload.severity.toUpperCase()}]* ${payload.title}\n${payload.body}`,
          attachments: payload.fields?.length
            ? [{ fields: payload.fields.map((f) => ({ title: f.name, value: f.value, short: false })) }]
            : undefined,
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[alerts] webhook returned ${res.status}`);
      }
    } catch (err) {
      // Don't let an alert-receiver outage cascade into the request path.
      console.warn(`[alerts] webhook failed: ${(err as Error).message}`);
    }
  })();
}
