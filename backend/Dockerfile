# syntax=docker/dockerfile:1.7
# Production Dockerfile for the HELM API.
#
# Multi-stage build:
#   1. deps       — install dependencies
#   2. runtime    — slim image, non-root user, healthcheck, no shell.
#
# Drop-in replacement for `bun run start` in production. The image
# runs as the dedicated `helm` user (uid 65532). The orchestrator
# (compose / k8s) MUST additionally set:
#   --read-only          (root filesystem is read-only at runtime)
#   --cap-drop=ALL       (drop all Linux capabilities)
#   --security-opt=no-new-privileges
#   --tmpfs /tmp:rw,noexec,nosuid
#   --read-only /home/helm
#   --user 65532:65532
# (See HARDENING.md for the full deployment recipe.)
#
# Build:   docker build -t helm-api:local -f backend/Dockerfile .
# Run:     docker run --rm -p 3000:3000 \
#              -e SESSION_SECRET=$(openssl rand -base64 48) \
#              -e ADMIN_PASSWORD=$(openssl rand -base64 24) \
#              -e DATABASE_URL=postgres://helm:...@db/helm \
#              -e WEB_ORIGIN=https://app.example.com \
#              -e HELM_TRUSTED_PROXY=1 \
#              helm-api:local

# ---- Stage 1: install deps ----
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ---- Stage 2: runtime ----FROM oven/bun:1.3.14-alpine
WORKDIR /app
RUN apk add --no-cache ca-certificates tini

# Create a non-root user (uid 65532 = "nobody" reserved for apps).
RUN addgroup -g 65532 -S helm && adduser -u 65532 -G helm -S helm

# Copy only what's needed at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY tsconfig.base.json ./

USER helm
WORKDIR /app
EXPOSE 3000

# Healthcheck — pings the same endpoint Bun's process is listening on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Bun's --smol trims RSS. tini reaps zombies (Bun handles signals,
# but tini is the standard PID-1 for containers).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "--smol", "run", "start"]
