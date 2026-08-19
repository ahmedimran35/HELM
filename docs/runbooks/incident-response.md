# Incident response runbook

This runbook is the on-call playbook. If you are responding to an
active incident right now, jump to **§3 Active incident checklist**.

## 1. Roles

- **Incident Commander (IC)** — owns the response, calls the shots.
- **Comms Lead** — internal + customer comms.
- **Scribe** — logs every action in the incident channel.
- **Subject Matter Experts (SME)** — backend / infra / security.

For severity-1 incidents the IC must be reachable within 15 minutes.
Escalation tree lives in the org's password manager (search for
`oncall-rotation`).

## 2. Severity definitions

| Sev | Definition                                                                                  | SLA      |
| --- | -------------------------------------------------------------------------------------------- | -------- |
| 1   | Active breach / data exfiltration / RCE in production                                        | < 1h fix |
| 2   | Confirmed vulnerability with exploit but no observed exploitation                            | < 24h    |
| 3   | Confirmed vulnerability, no exploit, mitigation incomplete                                   | < 7d     |
| 4   | Low-severity finding or hardening gap                                                        | < 30d    |

## 3. Active incident checklist

1. **Acknowledge** — say "IC: taking the incident" in the incident
   channel so everyone knows who's driving.
2. **Stop the bleeding** — the highest-priority action is the one
   that halts further damage. Reference runbooks:
   - Credential leak → `rotate-secrets.md`
   - Active exploitation of an endpoint → `block-traffic.md`
   - Compromised container → `revoke-compromised-pod.md`
3. **Preserve evidence** — snapshot logs, audit tables, container
   diffs. Don't reboot anything until the snapshot is captured.
4. **Communicate** — every 30 minutes the Comms Lead posts a status
   update, even if it's just "no new findings".
5. **Mitigate, don't necessarily fix** — a rate-limit + WAF rule is
   a fine interim mitigation. The proper fix can wait until the dust
   settles.
6. **Post-mortem** — within 7 days. Blameless. Output: timeline,
   root cause, action items with owners.

## 4. Communication templates

### Internal (Sev-1, all-hands)

```
Sev-1 incident: <one-line title>
IC: <name>  Comms: <name>
Status: investigating / mitigating / monitoring / resolved
Impact: <who/what is affected>
ETA to next update: 30 minutes
```

### External (customer-facing, only if customer data is at risk)

Coordinate with Legal before sending. Never speculate. Lead with
what you know, follow with what you're doing.

## 5. Tooling

- **Audit log** — `SELECT * FROM audit_log WHERE ts > now() - interval '24 hours'`
  (read-only role)
- **Container shell** — `kubectl exec -it deploy/api -- /bin/sh`
  (requires `kubectl-can-exec` IAM binding)
- **Log search** — `<log-search-url>` (Datadog / Loki / etc — replace)
- **Status page** — `<status-page-url>` (Statuspage / BetterUptime)

## 6. After-action

The IC is responsible for writing the post-mortem doc into
`docs/postmortems/YYYY-MM-DD-<slug>.md` and linking it from this
runbook. The template lives at `docs/runbooks/postmortem-template.md`.
