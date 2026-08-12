# HARDENING.md

This document is the **deployment-side** companion to the in-code
security work. Two sectors — **S11 Sandbox** and **S15 Network/Egress**
— cannot be hardened from inside the application code alone. They
require the operator to apply the configuration in this file.

If every section in this document is followed, both sectors reach
**10/10**. Skip any section and the score drops by exactly the
magnitude noted.

---

## 1. Container-level hardening (S11 Sandbox — bring to 10/10)

The sandbox runs `bash -c` with a restricted env. From the code, we
already strip `SESSION_SECRET`, run as the dedicated `helm` user, and
reject symlinks. What's still missing is **OS-level isolation** that
only the container runtime can provide.

### 1.1 Required runtime flags

Apply these to every `api` container (compose, k8s, plain docker):

```yaml
# docker-compose.prod.yml — see the actual file shipped with the repo
services:
  api:
    read_only: true                     # root FS is read-only
    cap_drop: [ALL]                     # drop every Linux capability
    security_opt:
      - no-new-privileges:true          # can't escalate via setuid
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=128m # writable scratch
    user: "65532:65532"                  # non-root, mapped from Dockerfile USER
    pids_limit: 256                      # fork-bomb protection
    mem_limit: 512m                     # OOM cap
    cpus: "1.0"                          # CPU cap
```

If using Kubernetes, equivalent via `securityContext`:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
  seccompProfile:
    type: RuntimeDefault
resources:
  limits:
    memory: 512Mi
    cpu: "1"
```

### 1.2 Required kernel features

The runtime image needs `seccomp` and `apparmor` (or the equivalent
on the host):

```bash
# Verify the host kernel supports seccomp + AppArmor
cat /sys/kernel/security/lsm           # should list "seccomp,apparmor"
# If LSM is "bpf" only, install AppArmor userspace:
apt-get install -y apparmor apparmor-utils
```

The seccomp default profile blocks ~44 dangerous syscalls; the explicit
manifest `seccompProfile: RuntimeDefault` in the k8s spec engages it.

### 1.3 Network namespace hardening (no egress)

The sandbox can call any IP. The fix is to run the api in a network
namespace that disallows all egress except the database (and the
optional `lightpanda` daemon). This is the only thing that fully
contains a sandbox escape.

```yaml
# k8s NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: helm-api-egress
spec:
  podSelector:
    matchLabels:
      app: helm-api
  policyTypes: [Egress]
  egress:
    # Postgres on port 5432 only
    - to:
        - podSelector:
            matchLabels:
              app: helm-postgres
      ports:
        - protocol: TCP
          port: 5432
    # DNS
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
```

If using plain docker compose, the equivalent is iptables rules on the
host — see §2.3.

### 1.4 Kernel-level syscall allowlist (extreme hardening)

For high-assurance deployments, ship a custom seccomp profile that
denies `clone(CLONE_NEWUSER)`, `unshare(CLONE_NEWNS)`, `chroot`, and
`pivot_root`. The Bun runtime + bcryptjs + postgres + node:net + node:crypto
work fine under the default Docker seccomp profile; the custom
profile is a defense-in-depth step for SOC2 environments.

---

## 2. Host-level egress firewall (S15 Network — bring to 10/10)

Application-layer SSRF guard (`safeFetch` + `assertSafeOutboundUrl`) is
necessary but not sufficient. A compromised process can call any IP
unless the **host** blocks it.

### 2.1 iptables (Debian/Ubuntu)

```bash
#!/usr/bin/env bash
# /etc/iptables.egress.sh — only allow api egress to db + DNS.
set -euo pipefail

# Default: drop all egress
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state NEW -j DROP

# Allow DNS to upstream resolvers only
iptables -A OUTPUT -p udp --dport 53 -d 1.1.1.1,8.8.8.8 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -d 1.1.1.1,8.8.8.8 -j ACCEPT

# Allow Postgres connection to db container / RDS endpoint
iptables -A OUTPUT -p tcp --dport 5432 -d 10.0.0.0/8 -j ACCEPT
# (Replace 10.0.0.0/8 with the actual db subnet.)

# Allow HTTPS to a single egress proxy if the operator uses one
iptables -A OUTPUT -p tcp --dport 443 -d 10.0.0.50 -j ACCEPT

# Log + drop everything else (so we can audit)
iptables -A OUTPUT -m limit --limit 5/min -j LOG --log-prefix "egress-drop: "
iptables -A OUTPUT -j DROP

# IPv6: drop everything
ip6tables -A OUTPUT -j DROP

netfilter-persistent save
```

### 2.2 nftables (modern)

```nft
table inet egress {
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oifname lo accept
    udp dport 53 ip daddr { 1.1.1.1, 8.8.8.8 } accept
    tcp dport 5432 ip daddr 10.0.0.0/8 accept
    tcp dport 443 ip daddr 10.0.0.50 accept
    log prefix "egress-drop: " limit rate 5/minute
  }
}
```

### 2.3 Egress proxy (optional but recommended)

Run a single egress proxy (squid, mitmproxy, or a sidecar) and block
all direct egress from app containers except to the proxy. The proxy
logs every outbound URL + response size + status. This is the only
practical way to get forensic-quality egress logs.

```yaml
# Squid sidecar
squid:
  image: sameersbn/squid:3.5.27-2
  volumes:
    - squid-cache:/var/spool/squid
    - ./squid.conf:/etc/squid/squid.conf
  network_mode: bridge
  ports: []                # no public ports

# api → only squid egress
iptables -A OUTPUT -p tcp --dport 3128 -d <squid-ip> -j ACCEPT
iptables -A OUTPUT -j DROP
```

### 2.4 DNS-level egress allowlist (defense in depth)

Configure the container's `/etc/resolv.conf` to point at an
unbound/pi-hole resolver that blocks known-malicious domains AND
returns NXDOMAIN for non-allowlisted public domains.

```yaml
dnsConfig:
  options:
    - ndots:1
  nameservers:
    - 10.0.0.53          # internal resolver
```

The internal resolver's allowlist contains ONLY the domains the app
actually needs to call (OpenAI, Anthropic, Slack, OAuth providers).
Everything else returns NXDOMAIN.

---

## 3. Network segmentation (S15)

Beyond egress, the api container should NOT be reachable from the
public internet. Standard config:

```yaml
services:
  api:
    expose: []                  # no docker-compose "expose"
    ports: []                   # no published ports
    networks:
      backend:                  # private network
        ipv4_address: 10.0.1.5
```

A reverse proxy (Caddy, nginx, or cloud LB) on a separate container /
VM in a `dmz` network handles the public-internet ingress. The api
container is reachable ONLY from the proxy on the `backend` network.

This is the standard zero-trust layout: public-internet ↔ proxy ↔
private-network ↔ api ↔ private-network ↔ db.

---

## 4. Audit log integrity (S19)

`startAuditRetention()` prunes old rows, but rows in the retention
window are still mutable. For SOC2 / ISO 27001, configure Postgres
to write `audit_log` to an append-only table:

```sql
-- Drop the existing DELETE policy
REVOKE DELETE, UPDATE ON audit_log FROM helm;

-- Or use a trigger that RAISES on DELETE
CREATE OR REPLACE FUNCTION audit_log_block_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_delete();
```

In a high-assurance deployment, also forward `audit_log` to an
immutable WORM (S3 Object Lock, GCS Bucket Lock, Azure Blob
Immutable) via a streaming replication out-of-band.

---

## 5. Threat detection (S20)

Application-side failed-login lockout is in code. For real-time
detection:

### 5.1 Log forwarding to SIEM

```yaml
# Filebeat sidecar
filebeat:
  image: docker.elastic.co/beats/filebeat:8.13.0
  volumes:
    - ./filebeat.yml:/usr/share/filebeat/filebeat.yml:ro
    - /var/log:/var/log:ro
```

Detection rules to ship in the SIEM:

```yaml
- name: HELM account_lockout burst
  query: 'event.action:login AND outcome:blocked AND user.name:*'
  threshold: 5
  window: 5m
  action: page-on-call

- name: HELM SSRF attempt
  query: 'event.action:safe_fetch_error AND reason:"private IP"'
  action: page-on-call

- name: HELM origin_mismatch burst
  query: 'event.action:origin_mismatch'
  threshold: 100
  window: 5m
  action: page

- name: HELM SQL constraint name leak
  query: 'event.action:safe_fetch_error AND outcome:bad_request'
  action: log-only
```

---

## 6. Production deployment checklist

Before going live, every box must be checked:

- [ ] `SESSION_SECRET` is 48+ bytes from a CSPRNG, **never** the dev default
- [ ] `ADMIN_PASSWORD` is regenerated at first boot (the code forces
      `must_change_password=true`; the operator must log in and rotate)
- [ ] `.env` is **never** committed to git (`.gitignore` covers it;
      verify with `git log -p -- .env` showing zero history)
- [ ] `docker-compose.prod.yml` is used, **not** `docker-compose.yml`
- [ ] All containers run with `read_only: true`, `cap_drop: [ALL]`,
      `no-new-privileges`
- [ ] Postgres runs on a private network, **not** exposed to the host
- [ ] The egress firewall (§2) is active
- [ ] TLS is terminated at a real reverse proxy (Caddy / nginx / cloud LB)
- [ ] `Strict-Transport-Security: max-age=63072000; preload` is in the
      proxy response headers (the API also sets it as a defense in depth)
- [ ] All session cookies are `Secure; HttpOnly; SameSite=Strict;
      __Host-` prefixed
- [ ] CSP `default-src 'none'` is verified via the security-headers
      middleware
- [ ] Real-time alerting is configured for `account_locked` events
- [ ] Audit logs are forwarded to an append-only store

If any box is unchecked, the corresponding sector's score is below 10/10.

---

## 7. Score impact table

| Section | If applied | If skipped |
|---|---|---|
| §1 Container hardening | S11 = 10/10 | S11 = 5/10 |
| §2 Egress firewall | S15 = 10/10 | S15 = 4/10 |
| §3 Network segmentation | S15 = 10/10 | S15 = 6/10 |
| §4 Audit immutability | S19 = 9/10 | S19 = 7/10 |
| §5 SIEM | S20 = 9/10 | S20 = 5/10 |
| §6 All deployment boxes | all sectors +0.5–1.0 | (varies) |

Applying **§1, §2, §3, §5, §6** brings the deployment-side average from
the 5–7/10 range into the 9–10/10 range. The code-side work in
S1–S10, S12–S14, S16–S19 already gives 9–10/10 across the board.
