# Block traffic runbook

Use this when an api endpoint is being actively exploited and you
need to cut it off without redeploying.

## 1. Read-only diagnostics first

Before blocking anything, snapshot the request volume so the
post-mortem has data.

```bash
# Per-endpoint request volume over the last 15m.
docker compose logs --since 15m api 2>&1 \
  | grep -oE '"GET /api/[^ "]+|"POST /api/[^ "]+' \
  | sort | uniq -c | sort -rn | head -20
```

## 2. Block at the reverse proxy

The api container does not expose a kill-switch endpoint (intentional
— we don't want a compromised api to be able to lock out its own
admin). Blocking happens at the reverse proxy.

### Caddy

```
# /etc/caddy/Caddyfile — temporary block
@app_block path /api/endpoint-being-exploited
respond @app_block 429 "blocked for security investigation" 60s
```

Reload: `systemctl reload caddy`.

### nginx

```nginx
# /etc/nginx/sites-enabled/helm.conf
location /api/endpoint-being-exploited {
    return 429;
}
```

Reload: `nginx -s reload`.

### Cloudflare / GCP / AWS

Use the provider's edge rules. Pin a header (`X-Sec-Block: 1`) so
you can later tell which requests were blocked vs which were
genuine 429s.

## 3. Block at the application layer (if no proxy)

If you're running without a proxy in front, the api's per-IP rate
limit can be tightened temporarily:

```bash
# Drop the limit for the offending IP to 0 by abusing the existing
# rate-limit middleware. Edit backend/src/middleware/ratelimit.ts
# to add an emergency allow/deny list (gitignored), then redeploy.
echo '["1.2.3.4"]' > backend/config/ratelimit-deny.json
docker compose restart api
```

## 4. Communicate

Update the status page. Don't speculate — say "we are temporarily
rate-limiting one endpoint while we investigate a security report".

## 5. After-action

1. Capture the logs you snapshotted in §1 into the incident channel.
2. Add the offending IP / user-agent to the permanent deny list
   in `backend/config/ratelimit-deny.json` (or the WAF config).
3. Open a ticket for the actual fix — this runbook is mitigation,
   not resolution.
4. Link the post-mortem from `incident-response.md`.
