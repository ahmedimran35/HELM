# syntax=docker/dockerfile:1.7
# Production Dockerfile for the HELM frontend (SPA).
#
# Multi-stage:
#   1. build   — Vite build of the React SPA into dist/
#   2. runtime — nginx:alpine serving dist/ and reverse-proxying the
#                API paths (/api, /apps, /apps-embed) to the api
#                service, mirroring the dev proxy in vite.config.ts.
#
# Single-origin deployment: the browser talks to this container only;
# cookies stay first-party, WS upgrades pass through, and the API is
# never exposed directly (drop the api `ports:` block in prod and keep
# it on the internal network).
#
# Build (context = repo root, same as backend/Dockerfile):
#   docker build -t helm-web:local -f frontend/Dockerfile .

# ---- Stage 1: build the SPA ----
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
WORKDIR /app

# Root manifest + lockfile first (layer cache), then the frontend.
COPY package.json bun.lock* ./
COPY frontend/package.json ./frontend/
RUN bun install --frozen-lockfile

COPY frontend ./frontend
COPY tsconfig.base.json ./
RUN cd frontend && bun run build

# ---- Stage 2: serve ----
# TODO(supply-chain): digest-pin once verified — resolve with
#   docker buildx imagetools inspect nginx:1.27-alpine
# (the api image pins oven/bun the same way; see backend/Dockerfile).
FROM nginx:1.27-alpine AS runtime

RUN apk add --no-cache openssl

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# Non-root: the stock image runs the master as root to bind :80 from
# its entrypoint script. Instead we bind a high port as an unprivileged
# user; uid 65532 matches the api's user.
RUN addgroup -g 65532 -S helm && adduser -u 65532 -G helm -S helm \
  && chown -R helm:helm /usr/share/nginx/html /var/cache/nginx /var/run \
  && touch /var/run/nginx.pid && chown helm:helm /var/run/nginx.pid
USER helm

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
