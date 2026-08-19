#!/usr/bin/env bash
# ============================================================================
# setup-egress.sh — lock down the api container's outbound traffic
# ============================================================================
#
# What this does:
#   * Creates an ipset `helm-egress-allow` (hash:net) of allowed subnets.
#   * Flushes the OUTPUT chain on the api container (or the host, when run
#     with --host) and re-applies a default-deny policy.
#   * Allows loopback, the docker bridge, postgres, redis, and the
#     lightpanda CDP host on the docker-compose network.
#   * Allows DNS (53) and outbound HTTPS to the resolved provider
#     allow-list (subnets added via --allow-subnet, see below).
#
# Idempotent: every rule is gated on `iptables -C` so a second run is a
# no-op. Safe to wire into a `post-up` hook or a systemd unit.
#
# Usage:
#   ./setup-egress.sh                          # apply to api container
#   ./setup-egress.sh --host                   # apply to host (production)
#   ./setup-egress.sh --allow-subnet 1.2.3.0/24 # add a custom subnet
#   ./setup-egress.sh --show                   # dump current rules
#   ./setup-egress.sh --reset                  # remove all egress rules
#
# Exit codes:
#   0  success (or --show / --reset ran cleanly)
#   1  iptables / ipset not available
#   2  invalid argument
# ============================================================================
set -euo pipefail

CHAIN="HELM-EGRESS"
IPSET_NAME="helm-egress-allow"

# Allowed subnets on the docker-compose network. Override with
# --allow-subnet for custom provider IPs.
POSTGRES_HOST="172.17.0.0/16"      # postgres
REDIS_HOST="172.17.0.0/16"         # redis
LIGHTPANDA_HOST="172.17.0.0/16"    # lightpanda (CDP)
DOCKER_BRIDGE="172.17.0.0/16"
LOOPBACK="127.0.0.0/8"
# Provider allow-list (HTTPS / 443). Add IPv4 CIDRs here for SaaS APIs
# the api container is permitted to call. DNS happens on UDP/53 first
# (see rules below).
PROVIDER_SUBNETS=(
  "104.18.0.0/16"      # cloudflare (slack, tavily, anthropic front)
  "151.101.0.0/16"     # fastly (slack, github)
  "140.82.112.0/20"    # github
  "13.107.42.14/32"    # microsoft
  "13.107.6.156/32"    # microsoft
)
EXTRA_SUBNETS=()

log() { printf '[egress] %s\n' "$*"; }
die() { printf '[egress] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    die "must run as root (or via sudo)"
  fi
}

has_iptables() { command -v iptables >/dev/null 2>&1; }
has_ipset()    { command -v ipset    >/dev/null 2>&1; }

# iptables -C returns 0 if the rule exists, non-zero otherwise.
ensure_rule() {
  # ensure_rule CHAIN SPEC...
  local chain="$1"; shift
  if iptables -C "$chain" "$@" 2>/dev/null; then
    return 0
  fi
  iptables -A "$chain" "$@"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)         TARGET="host"; shift ;;
      --allow-subnet) EXTRA_SUBNETS+=("$2"); shift 2 ;;
      --show)         DO_SHOW=1; shift ;;
      --reset)        DO_RESET=1; shift ;;
      -h|--help)      sed -n '2,40p' "$0"; exit 0 ;;
      *)              die "unknown argument: $1 (try --help)" ;;
    esac
  done
}

TARGET="container"
DO_SHOW=0
DO_RESET=0
parse_args "$@"

require_root
has_iptables || die "iptables not found in PATH"
has_ipset    || die "ipset not found in PATH (apt-get install ipset)"

# --- ipset allow-list -----------------------------------------------------
if ! ipset list -n "$IPSET_NAME" >/dev/null 2>&1; then
  log "creating ipset $IPSET_NAME (hash:net)"
  ipset create "$IPSET_NAME" hash:net
else
  log "ipset $IPSET_NAME already exists"
fi

add_to_ipset() {
  # add_to_ipset CIDR — idempotent.
  local cidr="$1"
  if ipset test "$IPSET_NAME" "$cidr" 2>/dev/null; then
    return 0
  fi
  ipset add "$IPSET_NAME" "$cidr"
  log "ipset add $cidr"
}

for cidr in "$LOOPBACK" "$DOCKER_BRIDGE" "${PROVIDER_SUBNETS[@]}" "${EXTRA_SUBNETS[@]}"; do
  [[ -z "$cidr" ]] && continue
  add_to_ipset "$cidr"
done

# --- iptables rules -------------------------------------------------------
if [[ $DO_RESET -eq 1 ]]; then
  log "removing chain $CHAIN (--reset)"
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  log "removing ipset $IPSET_NAME"
  ipset destroy "$IPSET_NAME" 2>/dev/null || true
  exit 0
fi

# Create (or flush) our chain.
if ! iptables -N "$CHAIN" 2>/dev/null; then
  log "chain $CHAIN already exists — flushing"
  iptables -F "$CHAIN"
fi

# Build rules inside the chain. Order matters: ESTABLISHED first, then
# explicit allow, then ipset, then default-deny jump at the end.
#
# 1. Loopback.
ensure_rule "$CHAIN" -o lo -j ACCEPT
log "allowed: loopback"

# 2. Established / related — return traffic for connections we opened.
ensure_rule "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
log "allowed: established/related"

# 3. Postgres (5432).
ensure_rule "$CHAIN" -p tcp -d "$POSTGRES_HOST" --dport 5432 -j ACCEPT
log "allowed: postgres (5432)"

# 4. Redis (6379).
ensure_rule "$CHAIN" -p tcp -d "$REDIS_HOST" --dport 6379 -j ACCEPT
log "allowed: redis (6379)"

# 5. Lightpanda CDP (9222).
ensure_rule "$CHAIN" -p tcp -d "$LIGHTPANDA_HOST" --dport 9222 -j ACCEPT
log "allowed: lightpanda (9222)"

# 6. DNS — TCP + UDP. Resolver IP is irrelevant because the container's
#    DNS proxy is on 127.0.0.11; we allow *out* to 53 on the bridge.
ensure_rule "$CHAIN" -p udp --dport 53 -j ACCEPT
ensure_rule "$CHAIN" -p tcp --dport 53 -j ACCEPT
log "allowed: dns (53)"

# 7. Provider allow-list — match against the ipset.
ensure_rule "$CHAIN" -p tcp --dport 443 -m set --match-set "$IPSET_NAME" dst -j ACCEPT
log "allowed: provider-allow-list (443, ipset=$IPSET_NAME)"

# 8. Default-deny everything else (logged for ops debugging).
ensure_rule "$CHAIN" -m limit --limit 5/min -j LOG --log-prefix "[egress-drop] " --log-level 4
ensure_rule "$CHAIN" -j DROP
log "default-deny: DROP"

# Wire the chain into OUTPUT.
if ! iptables -C OUTPUT -j "$CHAIN" 2>/dev/null; then
  iptables -I OUTPUT 1 -j "$CHAIN"
  log "hooked $CHAIN into OUTPUT (default-deny)"
fi

if [[ $DO_SHOW -eq 1 ]]; then
  echo "----- ipset $IPSET_NAME -----"
  ipset list "$IPSET_NAME" || true
  echo "----- chain $CHAIN -----"
  iptables -L "$CHAIN" -nv --line-numbers || true
  echo "----- OUTPUT chain (filtered) -----"
  iptables -L OUTPUT -nv --line-numbers | grep -E "($CHAIN|HELM)" || true
fi

log "egress firewall applied (mode=${TARGET})"
exit 0