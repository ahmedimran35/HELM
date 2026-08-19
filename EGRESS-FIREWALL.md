# Egress Firewall

The HELM api container needs to reach a small, well-known set of services
and **nothing else**. We enforce this in three layers so a single
misconfiguration can't widen the blast radius:

1. **Container-level** (iptables OUTPUT chain on the api container).
2. **Host-level** (nginx forward proxy with an explicit domain allow-list
   + an iptables rule pinning outbound 443 to the proxy port).
3. **WAF / per-request** (OWASP CRS at the front-door nginx).

This document covers layers 1 and 2. The WAF config is in
`scripts/waf-nginx.conf`.

---

## Layer 1 — Container egress (`scripts/setup-egress.sh`)

The script installs an `iptables` OUTPUT chain called `HELM-EGRESS` on
the api container (or on the host when run with `--host`) and a
default-deny policy at the bottom.

### Allowed destinations

| Service        | Port(s) | Why                                |
|----------------|---------|------------------------------------|
| Loopback       | any     | Same-container IPC                 |
| Established    | any     | Return traffic                     |
| Postgres       | 5432    | `postgres` service on docker net   |
| Redis          | 6379    | `redis` service on docker net      |
| Lightpanda CDP | 9222    | `lightpanda` browser on docker net |
| DNS            | 53      | Resolver (UDP + TCP)               |
| Provider ips   | 443     | ipset `helm-egress-allow`          |

Everything else is `LOG` + `DROP`.

### Usage

```bash
# On the api container (e.g. via docker exec, or inside the image).
sudo ./scripts/setup-egress.sh

# On the production host (covers all containers).
sudo ./scripts/setup-egress.sh --host

# Add a custom provider subnet (e.g. your private LLM gateway).
sudo ./scripts/setup-egress.sh --allow-subnet 10.20.0.0/16

# Inspect what is currently allowed.
sudo ./scripts/setup-egress.sh --show

# Tear it all down (e.g. for debugging).
sudo ./scripts/setup-egress.sh --reset
```

The script is **idempotent**: every rule is gated on `iptables -C` so a
second invocation is a no-op. Wire it into a `post-up` hook or a
systemd unit if you want it auto-reapplied on boot.

### What this does NOT protect against

* DNS exfiltration via `dig`/`host` against the docker resolver — we
  allow UDP/53 because we trust the docker internal resolver. If you
  need to harden further, run a local caching resolver inside the
  compose network and `--dport 53 -d <resolver-ip>` only.
* Outbound HTTP/80 — we drop it (default-deny), but the rule isn't
  commented as such. Add an explicit `-p tcp --dport 80 -j DROP` if
  you want clearer audit-log lines.

---

## Layer 2 — Host-level forward proxy (`scripts/egress-nginx.conf`)

When the api container runs on a multi-tenant host, we layer a second
default-deny on the **host** so a compromised container can't reach
arbitrary SaaS APIs even if the container-level rule is bypassed.

Setup:

1. Install the forward proxy from `scripts/egress-nginx.conf` on the
   host. It listens on `127.0.0.1:3128`.
2. Run the snippet at the bottom of the config to:
   * Allow outbound `tcp/3128` from the api container.
   * `--reject-with tcp-reset` every other outbound `tcp/443` from the
     api container so it can't bypass the proxy.
3. Set the api container's HTTPS proxy env:
   ```yaml
   environment:
     HTTPS_PROXY: http://host.docker.internal:3128
   ```
4. The proxy only allows:
   * `*.tavily.com`
   * `*.anthropic.com`
   * `*.openai.com`
   * `*.slack.com`
   * `*.googleapis.com`
   * `*.gstatic.com`

   Add more `if ($host ~ ...)` blocks to widen the allow-list; every
   other host returns `403`.

This belt-and-braces approach means a successful sandbox-exec escape
can't just `curl https://evil.example/...` — the network path is
physically unable to reach it.

---

## Layer 3 — OWASP CRS (`scripts/waf-nginx.conf`)

Front-door nginx terminates TLS and runs the OWASP Core Rule Set via
the `modsecurity-nginx` module. Out-of-scope for this doc; see the
config file for the full setup.

---

## Verifying

```bash
# From inside the api container, an HTTP request to an arbitrary host
# should time out / RST.
curl -m 5 https://example.com/ ; echo "exit=$?"

# DNS still works.
dig +short google.com

# Allowed providers still work.
curl -m 5 -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models
```

See `scripts/backup-restore-test.sh` for the DB-level restore drill
that exercises the full egress path end-to-end.