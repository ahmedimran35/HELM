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

## 3. Block at the application layer (no proxy)

There is **no built-in IP deny-list**, and nothing reads a config file
— the api's rate limits are per-route constants passed at mount time
in `backend/src/middleware/ratelimit.ts`. Writing a JSON deny list has
no effect.

Options, in order of preference:

1. Put a proxy or WAF in front (preferred — see §2).
2. Loosen or tighten the login lockout via env, then redeploy:
   - `HELM_LOGIN_LOCKOUT_THRESHOLD` (default `5` failed attempts)
   - `HELM_LOGIN_LOCKOUT_MINUTES` (default `15`)

   This covers failed-login lockout only; it does not cap general
   request rate.
3. As a last resort, edit the per-route `limit`/`windowMs` in the
   middleware and redeploy. That is a code change, not a config toggle.

Client-IP caveat: the limiter trusts `X-Forwarded-For` only when
`HELM_TRUSTED_PROXY=1`; otherwise it expects the edge to set
`cf-connecting-ip` or `x-real-ip`. Blocking at the wrong layer means
blocking the wrong IP.

## 4. Communicate

Update the status page. Don't speculate — say "we are temporarily
rate-limiting one endpoint while we investigate a security report".

## 5. After-action

1. Capture the logs you snapshotted in §1 into the incident channel.
2. Add the offending IP / user-agent to your **edge** WAF rules.
   There is no in-app deny list to update (see §3).
3. Open a ticket for the actual fix — this runbook is mitigation,
   not resolution.
4. Link the post-mortem from `incident-response.md`.
