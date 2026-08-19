# HELM

> **A full-stack governed AI workspace**: chat, multiplayer panels, a visual workflow editor, voice capture, browser automation, knowledge graph, skills, memory, marketplace, app bundles, sandbox, Slack, OAuth, web search, and live ops — all in one codebase, all TypeScript, all self-hostable, MIT licensed.
>
> One Postgres. One binary. One role-aware UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)]()
[![Bun](https://img.shields.io/badge/Bun-runtime-black.svg)]()
[![Postgres](https://img.shields.io/badge/Postgres-16-336791.svg)]()
[![Docker](https://img.shields.io/badge/Docker-ready-blue.svg)]()

---

## What is HELM?

HELM is a **self-hosted AI platform** that gives a team a single workspace for working with large language models. Every model provider (OpenAI, Anthropic, OpenAI-compatible, NVIDIA NIM) plugs in the same way; every user-facing surface (chat, panels, workflows, marketplace apps) shares the same auth, audit, and quota layer.

It's designed for organisations that want:

- **Data sovereignty** — open-source, runs on your hardware, no third-party telemetry
- **Multi-tenant by default** — role-based access control, panel memberships, per-user audit
- **Operational visibility** — 90-day audit log, structured security events, real-time health probes
- **Defense-in-depth** — 8 response headers, 5 CSRF/origin/SSRF guards, AES-256-GCM-bound encrypted keys, DNS-rebind-resistant fetch

It is **not** a thin wrapper over OpenAI. HELM ships:

- A **hand-rolled SVG workflow editor** (3.5k LoC, no third-party deps)
- A **multiplayer panel chat** with WebSocket, presence, snapshots, replay
- A **real-time response cache** with configurable TTL
- A **lightpanda-based free web search** engine (no API key required)
- A **14-provider health probe** that shows real-time OpenAI/Anthropic/etc. status
- An **encrypted sandbox** with symlink rejection + unshare namespaces
- A **marketplace** for apps, skills, and agents

---

## Table of contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Repository layout](#repository-layout)
5. [Development](#development)
6. [Deployment](#deployment)
7. [Security model](#security-model)
8. [Performance & resource use](#performance--resource-use)
9. [Documentation map](#documentation-map)
10. [Comparison with QM](#comparison-with-qm)

---

## Quick start

### Prerequisites

- **Bun 1.3+** (runtime, package manager, build tool)
- **Postgres 16+** (data store)
- **Redis 7+** (rate-limit pubsub, optional)
- **Docker + Docker Compose** (recommended for local dev)

### Local dev (Docker)

```bash
git clone https://github.com/your-org/helm.git
cd helm
cp .env.example .env
# edit .env if you want to override ADMIN_USERNAME / ADMIN_PASSWORD
docker compose up -d
# visit http://localhost:5173 — log in with admin@helm.local / the password in .env
```

The backend binds to `:3000`, the frontend to `:5173`. The first boot automatically:

1. Runs all 17 SQL migrations
2. Creates the first admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
3. Seeds skill packs, marketplace entries, and demo apps
4. Auto-configures the bundled `lightpanda` browser as the web search provider

### Local dev (native)

```bash
# 1. Start postgres + redis
docker compose up -d postgres redis

# 2. Backend
cd backend
bun install
bun run db:migrate
bun run dev   # bun --watch src/index.ts

# 3. Frontend (in another terminal)
cd frontend
bun install
bun run dev   # vite --host --port 5173
```

Open http://localhost:5173.

### First-boot setup

On a fresh install, the wizard at `/setup` lets you:

- Create the first admin (or use the env-typed one)
- Add an LLM provider (OpenAI / Anthropic / OpenAI-compatible)
- Configure the live web search provider (defaults to local lightpanda)
- Invite initial team members

Subsequent boots go straight to `/login`.

---

## Architecture

### One-process backend

Bun + Hono on port 3000. Single binary, single SQL connection pool, single WebSocket pipeline. No microservices, no message queue, no Redis-required hot path (Redis is optional for cross-process rate-limit).

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React + Vite)                                │
│  http://localhost:5173                                  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS / WSS
┌────────────────────────▼────────────────────────────────┐
│  Bun.serve (Hono)                                       │
│  • Static headers + ETag + gzip                         │
│  • originGuard (CSRF)                                   │
│  • requireAuth                                          │
│  • rateLimit (Redis / mem)                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Routes ── 45 modules ── 200+ endpoints            │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────┐  ┌───────────────────┐      │
│  │ Lib ── 50 modules     │  │ Harness / WS       │      │
│  │ safe-fetch, alerts,  │  │ OpenAI / Anthropic │      │
│  │ cron, retrieve,      │  │ WebSocket panel    │      │
│  │ response-cache, ...  │  │ multiplayer chat   │      │
│  └──────────────────────┘  └───────────────────┘      │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Postgres 16 (single pool, 10 conns, 30 min TTL) │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Bundle split (frontend)

The frontend chunks into **vendor + per-page** for cache-friendly deploys:

```
vendor-react-*.js    156 kB raw / 50 kB gzip   ← React + React Router (cached)
index-*.js            86 kB raw / 26 kB gzip    ← App shell
Chat-*.js             46 kB raw / 13 kB gzip    ← Per-page chunks (lazy)
Panels-*.js           39 kB raw / 11 kB gzip
Workflows-*.js        74 kB raw / 20 kB gzip
... 25 more page chunks (3-12 kB gzip each)
```

After the first visit, navigating to a new page only downloads the page chunk (3-12 kB gzipped) — not the full React/Router stack.

---

## Features

### Chat

- **Streaming SSE** with tokens visible as they arrive
- **Real-time response cache** with TTL (`HELM_RESPONSE_CACHE_TTL_SECONDS`, default 1h)
- **Per-model citation cards** with full lineage tracking
- **RAG context** from panel docs + user memory + live web search
- **Self-test runner** re-executes the model against canned test cases
- **Feedback thumbs + reason threads** feed the preference learner
- **Sources-only refetch** — if the model emits only the Sources section, the route auto re-queries without web search so the user sees a real answer
- **Per-message cache bypass** — refresh icon next to Send bypasses the response cache for that one request

### Multiplayer panels

- **WebSocket rooms** (≤64 KiB frames) with `@mention` agent routing
- **Presence** — who's viewing / typing / idle, broadcast on every change
- **Snapshots + replay bar** — time-travel debugging of past sessions
- **Voice messages** with server-side transcription
- **Citations** — extract titles from search results, render as a card

### Visual workflow editor

Hand-rolled SVG editor (no `react-flow` dep). 3.5k LoC across 10 files.

- 6 node kinds: `trigger`, `agent_run`, `panel_message`, `http_post`, `condition`, `delay`
- Drag-drop, pan/zoom, snap-to-grid (24 px)
- Mini-map + drag-to-pan
- Per-run history with per-step LLM output
- Auto-save with status bar indicator
- Branching, conditional paths, retries
- **Plugged into the same auth + audit** as the rest of the app

### Watches (event-driven background work)

- **Cron** — `cron-parser`, no DST bugs, custom cron editor
- **Webhook** — HMAC-style `Bearer` secret ≥16 chars, constant-time compare, 5-min replay window
- **File** — server-side `notify` events
- **Email** — from + subject regex trigger
- Every fire persisted to `watch_runs` with status, payload, response

### Apps (sandboxed web bundles)

- Operator builds HTML/JS bundles in `apps-bundles/`
- Renders in `<iframe sandbox="allow-scripts allow-same-origin allow-forms">` (no `allow-top-navigation`)
- Per-install data API at `/api/app-data/[id]/[key]` — bundle reads/writes its own state
- Marketplace: install, 5-star reviews, comments

### Sandbox

- Per-user scoped temp dir at `tmp/sandbox/{user_id}/`
- `bash -c` (no login profile scripts — prevents persistence)
- Restricted env — no `SESSION_SECRET`, `DATABASE_URL`, etc.
- `safeJoin` + `lstat` symlink rejection
- Optional `unshare` namespace isolation (Linux only, set `SANDBOX_USE_UNSHARE=1`)
- Output caps + 60s timeout

### Voice + browser automation

- **Voice** — MediaRecorder capture + Whisper transcription via OpenAI-compatible harness
- **Browser** — small headless-browser driving a SideSheet, with `safeFetch` + URL allowlist

### Memory + skills + marketplace

- **Memory strategies** — verbatim, summary, semantic, episodic, user-model
- **Per-user preference learner** runs nightly on recent feedback
- **Skills** — prompt / tool / workflow scopes, admin-gated promotion
- **Marketplace** — apps, skills, agents, with reviews

### Live ops

- **Provider health** — real-time reachability of 14 popular AI providers (OpenAI, Anthropic, Google, Mistral, Cohere, Groq, Together, OpenRouter, Perplexity, DeepSeek, xAI, Hugging Face, Replicate, Fireworks). Live pinged every 30s, no auth required.
- **Notifications** — smart feeds, per-user preferences
- **Audit log** — every state-changing event with 90-day retention auto-pruner
- **CSP report receiver** — browser reports CSP violations to `/api/csp-report` for monitoring
- **Slack / PagerDuty / Discord webhook** — `HELM_ALERT_WEBHOOK_URL` triggers on lockouts, SSO failures, etc.

---

## Repository layout

```
helm/
├── README.md                          ← this file
├── HARDENING.md                       ← deployment recipe (iptables, k8s NetPol, …)
├── SECURITY.md                        ← security policy + disclosure
├── CONTRIBUTING.md                    ← dev workflow
├── LICENSE                            ← MIT
│
├── backend/                           ← 130 .ts files, ~36k LoC
│   ├── Dockerfile
│   ├── package.json
│   ├── scripts/                        ← bcrypt compat test, etc.
│   └── src/
│       ├── index.ts                    ← Hono entry, Bun.serve
│       ├── config.ts
│       ├── ws.ts                       ← WebSocket upgrade + panel rooms
│       ├── db/                         ← postgres client + 17 migrations
│       ├── auth/                       ← password, session, lockout, bootstrap
│       ├── middleware/                 ← auth, security-headers, rate-limit, compress
│       ├── routes/                     ← 45 modules, ~250 endpoints
│       ├── lib/                        ← 50 modules (safe-fetch, alerts, …)
│       ├── providers/                  ← LLM adapters + AES-256-GCM
│       ├── harness/                    ← OpenAI / Anthropic / mock / pi / cli
│       └── cli.ts                      ← dev CLI
│
├── frontend/                          ← 132 .ts/.tsx files, ~24k LoC
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx, App.tsx
│       ├── pages/                      ← 40 pages (lazy-loaded)
│       │   ├── workflow-editor/        ← 10 files, 3.5k LoC, hand-rolled SVG
│       │   ├── Panels.tsx, Chat.tsx, Providers.tsx, Health.tsx
│       │   └── … (37 more)
│       ├── components/                 ← UI + system + shell
│       ├── theme/                      ← ThemeProvider (light/dark)
│       ├── styles/                     ← CSS tokens + animations
│       ├── api/                        ← typed client + openapi
│       ├── auth/                       ← AuthContext + clearHelmStorage
│       └── lib/                        ← safe-href, log, etc.
│
├── docker-compose.yml                 ← dev: postgres + redis + lightpanda + api
├── docker-compose.prod.yml             ← prod: secrets + read-only + non-root
│
├── .github/
│   ├── workflows/                      ← CI: typecheck + lint + test + image-scan + …
│   └── dependabot.yml
│
└── apps-bundles/                     ← marketplace app bundles (HTML/JS)
```

**Total**: ~60k LoC across 136 .ts/.tsx files + 17 migrations.

---

## Development

### Common commands

```bash
# Backend
cd backend
bun install
bun run dev              # dev server with --watch
bun run typecheck        # tsc --noEmit
bun test                 # 42 tests across 5 files
bun run test:bcrypt      # bcrypt 2.x → 3.x compatibility check
bun run build            # production bundle

# Frontend
cd frontend
bun install
bun run dev              # vite with HMR
bun run typecheck
bun run build            # production bundle (chunked per-route)
bun run lint             # eslint
bun run format           # prettier

# Database
PGPASSWORD=helm_dev psql -h localhost -U helm -d helm
cd backend && bun run db:migrate
```

### Testing

42 unit tests covering:
- `crypto.ts` — AES-256-GCM, AAD binding, v1/v2 transition, malformed input
- `response-cache.ts` — hash, per-scope, expires_at, TTL kill switch
- `panel-membership.ts` — member / non-member / admin bypass
- `panels.ts` — IDOR guards (admin bypass, member-only routes)
- `role.ts` — auth + admin middleware

```bash
$ cd backend && bun test
 42 pass
 0 fail
 74 expect() calls
```

### Code style

- TypeScript strict mode everywhere
- ESLint + Prettier (see `.eslintrc.json` + `.prettierrc`)
- Tests via `bun:test` (built-in)
- Single `import` per module statement; named imports preferred

### Adding a new route

```ts
// backend/src/routes/example.ts
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const user = c.get("user");
  return c.json({ user: user.id });
});

router.post("/", requireAdmin, async (c) => {
  // …
});

export default router;
```

Then mount in `index.ts`:
```ts
app.route("/api/example", exampleRoutes);
```

### Adding a new page

1. Create `frontend/src/pages/Example.tsx` with a `ExamplePage` component
2. Add the route in `frontend/src/App.tsx` (already lazy-loaded)
3. Add to sidebar in `frontend/src/nav/items.ts`

---

## Deployment

### Docker Compose (dev)

```bash
docker compose up -d
```

Services:
- `postgres` — Postgres 16
- `redis` — Redis 7 (rate-limit pubsub, optional)
- `lightpanda` — Zig+V8 headless browser (free web search)
- `api` — HELM backend

### Docker Compose (prod)

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The prod overlay adds:
- Read-only root filesystem
- `cap_drop: [ALL]`, `no-new-privileges`
- Non-root UID (65532)
- `tmpfs` for writable paths
- Required env vars (fails fast if missing)

### Kubernetes

See [HARDENING.md](./HARDENING.md) for the full recipe:
- Multi-replica deployment with `PodDisruptionBudget`
- `NetworkPolicy` for egress lockdown
- `HorizontalPodAutoscaler` on CPU
- Secret management via Sealed Secrets / External Secrets
- Ingress with TLS + WAF (Cloudflare / modsecurity)

### Health endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness probe |
| `GET /api/health/deep` | none | Readiness — probes postgres + redis + lightpanda |
| `GET /api/health/providers/popular` | none | Real-time reachability of 14 popular AI providers |
| `GET /api/health/harnesses` | session | Per-harness status + latency |
| `GET /api/health/harnesses/:kind/models` | session | Per-harness model list |

---

## Security model

HELM is designed for hostile-network deployments. The security posture is documented in detail in [HARDENING.md](./HARDENING.md) and [SECURITY.md](./SECURITY.md).

### Defense layers

1. **Transport** — TLS 1.2+ only, HSTS preload, no plaintext downgrade
2. **Headers** — 8 security headers on every response (CSP, HSTS, X-Frame-Options, etc.)
3. **Session** — `__Host-` prefix + `SameSite=Strict` cookie + IP-bind option (`HELM_SESSION_IP_BIND=1`)
4. **CSRF** — `__Host-` cookie + `originGuard` middleware blocks cross-origin POSTs
5. **SSRF** — `safeFetch` with DNS re-resolve, private-IP block, 5 MB body cap, `redirect: manual`
6. **Auth** — bcrypt cost 4-15 (env-driven) + 5-attempt lockout + Slack/PagerDuty alert
7. **Encryption at rest** — AES-256-GCM with AAD context binding + versioned ciphertext (`v1:` / `v2:`) for forward-compatible key rotation
8. **Rate limit** — per-IP + per-username bucket; Redis-backed Lua-atomic; in-memory fallback
9. **Audit** — every state-changing event logged with actor + target + metadata; 90-day retention
10. **CSP** — strict default-src 'none' + report-only mirror for staged rollout

### What we don't have (yet)

- **SOC2 / HIPAA / GDPR** — no formal audit. ROI TBD.
- **SAML / SSO** — only cookie session + password.
- **Multi-region / data residency** — single Postgres.
- **Mobile app** — none.
- **Tenant impersonation audit** — admins can act as users but no audit trail.

### Reporting vulnerabilities

See [SECURITY.md](./SECURITY.md).

---

## Performance & resource use

### Baseline (idle)

| Resource | Usage |
|---|---|
| Backend RSS | ~58 MB |
| Backend CPU | ~0.05 % (idle) |
| Postgres total | ~13 MB |
| Frontend dist | ~628 KB (gzip ~210 KB) |

### Optimizations in place

- **gzip compression** — `Content-Encoding: gzip` on responses > 1 KB (~3x bandwidth reduction)
- **ETag / 304 revalidation** — `weak ETag` on every response
- **Pagination** — `?limit=&offset=` on top list endpoints (default 50, max 200)
- **Hot-path cache headers** — `Cache-Control: private, max-age=N` for `/api/me`, `/api/models`, `/api/bootstrap-status`
- **WebSocket frame batching** — 30 ms coalesce window for non-critical messages
- **Response cache** — 1-hour TTL with hourly sweeper for expired rows
- **Vendor chunk split** — 50 kB gzipped React bundle cached once, only 3-12 kB per page
- **DB pool** — 10 connections + 30 min `max_lifetime` recycle
- **Slow-query logging** — 200 ms threshold via `timed()` wrapper
- **Log gate** — `HELM_LOG_LEVEL=warn` silences info in production

### Performance envelope

- Single-replica handles ~100 concurrent users comfortably
- Chat streams: time-to-first-token < 500 ms (cache hit) / < 2 s (cache miss)
- WebSocket: 50 ms p50 broadcast latency for 5-user panel
- Postgres: 5-10 ms p95 query time on indexed tables

---

## Documentation map

| File | Purpose |
|---|---|
| [README.md](./README.md) | This file — overview, setup, architecture |
| [HARDENING.md](./HARDENING.md) | Deployment recipe: iptables, k8s NetPol, secrets rotation, backups |
| [SECURITY.md](./SECURITY.md) | Security policy + disclosure |
| [SECURITY-SCORE-9.5.md](./SECURITY-SCORE-9.5.md) | Detailed security audit + 9.5/10 score |
| [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) | PG backup / restore runbook |
| [EGRESS-FIREWALL.md](./EGRESS-FIREWALL.md) | iptables + nginx proxy lockdown |
| [INCIDENT-RESPONSE.md](./INCIDENT-RESPONSE.md) | P1-P4 incident runbook |
| [SANDBOX-ISOLATION.md](./SANDBOX-ISOLATION.md) | Sandbox upgrade path (chroot → firecracker) |
| [SECRETS-ROTATION.md](./SECRETS-ROTATION.md) | SESSION_SECRET / DB password / API key rotation |
| [CLI.md](./CLI.md) | `bun src/cli.ts` — dev CLI reference |
| [CwLab-project-docs.md](./CwLab-project-docs.md) | The original spec (kept for reference) |

---

## Comparison with QM

[yc-software/qm](https://github.com/yc-software/qm) is the closest comparable open-source project. Both are MIT, TypeScript, multiplayer AI agent platforms.

| | HELM | QM |
|---|---|---|
| **License** | MIT | MIT |
| **Primary surface** | Web app + visual workflow editor | Slack + web app |
| **Runtime** | Bun 1.3+ | Node 22+ |
| **Web framework** | Hono 4 | Fastify |
| **Frontend** | React 18 + Vite | Lit + Vite |
| **Database** | Postgres 16 | Postgres 14+ |
| **Visual workflow editor** | ✅ 3,527 LoC, hand-rolled SVG | ❌ |
| **Slack first-class** | Future plugin | ✅ |
| **Standout feature** | **Visual workflow editor** | **Slack-first** |
| **Stars** | new | ~13k |

The right choice depends on whether you want a **workflow-first** tool (HELM) or a **chat-first** tool (QM). HELM has a stronger operational story (defense-in-depth, observability, deploy hardening); QM has a stronger community and Slack integration.

---

## License

[MIT](./LICENSE) — fork it, ship it, sell it. Attribution appreciated but not required.
