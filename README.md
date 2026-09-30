# HELM

> **A full-stack governed AI workspace**: chat, multiplayer panels, a visual workflow editor, an experimental multi-model swarm, skills, memory, marketplace, app bundles, sandbox, OAuth, web search, approvals, spend caps, and live ops — all in one codebase, all TypeScript, all self-hostable, MIT licensed.
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

- A **hand-rolled SVG workflow editor** (~4.0k LoC, no third-party deps)
- A **multiplayer panel chat** with WebSocket, presence, snapshots, replay
- A **real-time response cache** with configurable TTL
- A **lightpanda-based free web search** engine (no API key required)
- A **14-provider health probe** that shows real-time OpenAI/Anthropic/etc. status
- A **sandbox** with per-user working dirs, symlink-rejecting file APIs, and opt-in `unshare` namespaces (exec is off by default)
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
git clone https://github.com/ahmedimran35/HELM.git
cd helm
cp .env.example .env
# REQUIRED: set a strong admin password in .env before first boot —
# there is intentionally no default (a known-password admin account is
# a critical hole on any deployed stack).
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
docker compose up -d
# visit http://localhost:8080 — log in with admin@helm.local / the password in .env
```

The API binds to `:3000`; the Docker frontend serves the built SPA on
`:8080` (`:5173` is only the native Vite dev server). The first boot
automatically:

1. Runs all 18 SQL migrations
2. Creates the first admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (skipped if users already exist)
3. Seeds skill packs, marketplace entries, and demo apps
4. Auto-configures the bundled `lightpanda` browser as the web search provider

The env-bootstrapped admin is created with `must_change_password=true`,
so the first login forces a password change — the .env secret is assumed
leaked by being in the deployment manifest.

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

Starting with zero users, the backend auto-creates the first admin from
`ADMIN_USERNAME` / `ADMIN_PASSWORD` (see bootstrap above) and that
account must change its password on first login. The in-app wizard at
`/setup` additionally lets you:

- Add an LLM provider (OpenAI / Anthropic / OpenAI-compatible)
- Configure the live web search provider (defaults to local lightpanda)
- Invite initial team members

Once any user exists, boots go straight to `/login` (and stale
`ADMIN_*` env values are ignored).

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
│  │ Routes ── 39 modules ── 200 endpoints            │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────┐  ┌───────────────────┐      │
│  │ Lib ── 34 modules     │  │ Harness / WS       │      │
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
Chat-*.js             47 kB raw / 13 kB gzip    ← Per-page chunks (lazy)
Panels-*.js           39 kB raw / 11 kB gzip
Workflows-*.js        74 kB raw / 21 kB gzip
... 37 more chunks (0.3–9 kB gzip each; most pages < 4 kB)
```

After the first visit, navigating to a new page only downloads that page's chunk — not the full React/Router stack.

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

Hand-rolled SVG editor (no `react-flow` dep). ~4.0k LoC across 15 files.

- 6 node kinds: `trigger`, `agent_run`, `panel_message`, `http_post`, `condition`, `delay`
- Drag-drop, pan/zoom, snap-to-grid (24 px)
- Mini-map + drag-to-pan
- Per-run history with per-step LLM output
- Auto-save with status bar indicator
- Branching, conditional paths, retries
- **Plugged into the same auth + audit** as the rest of the app

### Watches (event-driven background work)

- **Cron** — `cron-parser`, no DST bugs, custom cron editor
- **Webhook** — mandatory `Bearer` secret (≥16 chars) compared in constant time. No request-timestamp check, so a captured request can be replayed — treat the secret as the only guard.
- **Manual** — fire a watch on demand via the API
- Every fire persisted to `watch_runs` with status, payload, response

`file` and `email` exist as accepted `source` values but have no firing
path: nothing watches the filesystem, and there is no inbound-mail
handler. Only `schedule`, `webhook`, and `manual` watches actually run.

### Apps (sandboxed web bundles)

- Operator builds HTML/JS bundles in `apps-bundles/`
- Renders in `<iframe sandbox="allow-scripts allow-same-origin allow-forms">` (no `allow-top-navigation`)
- Per-install data API at `/api/app-data/[id]/[key]` — bundle reads/writes its own state
- Marketplace: install, 5-star reviews, comments

### Sandbox

> **Shell exec is disabled by default.** The plain `bash -c` path is not
> a jail — there is no chroot, seccomp filter, or capability drop, so it
> can read host files and other users' sandbox dirs. The exec endpoint
> returns `403 sandbox_isolation_required` unless you explicitly opt in.

- Per-user working dir at `tmp/sandbox/{user_id}/`; each session gets its own scratch `TMPDIR`
- File API rejects symlinks (`lstat`) and `../` traversal (`safeJoin`)
- Restricted env — `PATH`/`HOME`/`TMPDIR` only; no `SESSION_SECRET`, `DATABASE_URL`, etc.
- Output caps — 512 KB per stream; timeout defaults to 30 s, max 5 min
- Files are stored **unencrypted** (local disk + `file_blobs`)

To enable exec, pick one:

- `SANDBOX_USE_UNSHARE=1` — Linux only. Wraps exec in
  `unshare --user --map-root-user --net --mount-proc --pid --fork`,
  giving the child its own user/net/pid namespaces (netns = no external
  connectivity). The per-exec response reports `isolation: "unshare"`.
  The server probes for the `unshare` binary at boot; if it is missing
  (or the env var is set on a non-Linux host) exec stays **disabled**
  and the boot log says so, rather than advertising isolation it
  cannot provide.
- `SANDBOX_ALLOW_UNSAFE_EXEC=1` — single-user dev hosts only (e.g.
  macOS, which lacks `unshare(1)`). Plain `bash -c`, no namespace
  isolation. Never set this multi-tenant or in production.

Not implemented: chroot/`pivot_root`, seccomp, `RLIMIT_AS`/`RLIMIT_CPU`,
capability drop, AppArmor/SELinux, Landlock, and per-user microVMs. See
SANDBOX-ISOLATION.md for the upgrade path.

### Voice + browser automation

- **Voice** — server-side audio transcription via an OpenAI-compatible
  harness (`POST /api/files/:id/describe` → Whisper). Live microphone
  capture UI and Text-to-Speech are not yet wired in the frontend.
- **Browser** — the bundled headless `lightpanda` browser is used for
  web search; there is no user-facing browser-driving UI.

### Memory + skills + marketplace

- **Memory strategies** — three kinds: `rows` (verbatim), `summary` (LLM-compressed), and `vector` (semantic search)
- **Per-user preference learner** runs nightly on recent feedback
- **Skills** — prompt / tool / workflow scopes, admin-gated promotion
- **Marketplace** — apps, skills, agents, with reviews

### Agents Swarm (experimental, admin-only)

- Pick 2–10 governed models, ask one question
- Every agent shares one web-search run, answers independently, scores its peers, debates in dynamic rounds (LLM consensus check each round, hard cap 10), then a separate synthesizer merges the strongest claims
- Live force-directed swarm visualization, per-round timeline, and score table
- Server-side history (`GET /api/swarm/runs`) with the final answer, model count, rounds, and status

### Live ops

- **Provider health** — real-time reachability of 14 popular AI providers (OpenAI, Anthropic, Google, Mistral, Cohere, Groq, Together, OpenRouter, Perplexity, DeepSeek, xAI, Hugging Face, Replicate, Fireworks). Results are cached for 30 s and refreshed on request; the probe endpoint itself requires no auth.
- **Notifications** — smart feeds, per-user preferences
- **Audit log** — every state-changing event with 90-day retention auto-pruner
- **CSP report receiver** — browser reports CSP violations to `/api/csp-report` for monitoring
- **Alerting webhook** — a single Slack-compatible incoming webhook via `HELM_ALERT_WEBHOOK_URL` (`{text, attachments}` payload). Triggers on lockouts, SSRF attempts, model-access escalation, etc.; PagerDuty / Discord / Mattermost work only if their URL accepts a Slack-shaped body.

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
├── backend/                           ← 139 .ts files, ~31k LoC
│   ├── Dockerfile
│   ├── package.json
│   ├── scripts/                        ← bcrypt compat test, etc.
│   └── src/
│       ├── index.ts                    ← Hono entry, Bun.serve
│       ├── config.ts
│       ├── ws.ts                       ← WebSocket upgrade + panel rooms
│       ├── db/                         ← postgres client + 18 migrations
│       ├── auth/                       ← password, session, lockout, bootstrap
│       ├── middleware/                 ← auth, security-headers, rate-limit, compress
│       ├── routes/                     ← 39 modules, ~200 endpoints
│       ├── lib/                        ← 34 modules (safe-fetch, alerts, …)
│       ├── providers/                  ← LLM adapters + AES-256-GCM
│       ├── harness/                    ← OpenAI / Anthropic / mock / pi / cli
│       └── cli.ts                      ← dev CLI
│
├── frontend/                          ← 88 .ts/.tsx files, ~30k LoC
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx, App.tsx
│       ├── pages/                      ← page components (lazy-loaded)
│       │   ├── workflow-editor/        ← 15 files, ~4.0k LoC, hand-rolled SVG
│       │   ├── swarm/                  ← Agents Swarm canvas/timeline/scores/picker
│       │   ├── Panels.tsx, Chat.tsx, Providers.tsx, Health.tsx
│       │   └── … (more)
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

**Total**: ~61k LoC across 227 .ts/.tsx files + 18 migrations.

---

## Development

### Common commands

```bash
# Backend
cd backend
bun install
bun run dev              # dev server with --watch
bun run typecheck        # tsc --noEmit
bun test                 # tests across 12 files (run `bun test` to see current totals)
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

Tests across 12 files covering:

- `crypto.ts` — AES-256-GCM, AAD binding, v1/v2 transition, malformed input
- `response-cache.ts` — hash, per-scope, expires_at, TTL kill switch
- `safe-fetch.ts` — SSRF / private-IP guard, redirect handling
- `panel-membership.ts` — member / non-member / admin bypass
- `panels.ts` — IDOR guards (admin bypass, member-only routes)
- `role.ts` — auth + admin middleware
- `workflow-runner.ts` — graph validation + condition predicates
- `sandbox.ts` — exec isolation gate, symlink / traversal rejection
- `openai.ts` — OpenAI harness request/response shaping
- `metrics.ts` — counter/gauge accounting
- `sources-injection.ts` — web-search source citation injection
- `_contract.ts` — authz contract matrix (anonymous / user / admin per route)

Note: two `safe-fetch` cases fail without outbound DNS (they resolve
`example.com`); they pass on a networked host. Run `bun test` for current
pass/fail totals rather than relying on numbers pinned here.

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
| `GET /api/health/deep` | none | Readiness — probes postgres, plus redis (only when `REDIS_URL` is set) and lightpanda (only when an HTTP daemon URL is configured; CLI mode is treated as OK) |
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
6. **Auth** — bcrypt cost 4-15 (env-driven) + 5-attempt lockout + alerting webhook
7. **Encryption at rest** — AES-256-GCM with AAD context binding + versioned ciphertext (`v1:` / `v2:`) for forward-compatible key rotation
8. **Rate limit** — per-IP + per-username bucket; Redis-backed Lua-atomic; in-memory fallback
9. **Audit** — every state-changing event logged with actor + target + metadata; 90-day retention
10. **CSP** — strict default-src 'none' + report-only mirror for staged rollout

### What we don't have (yet)

- **SOC2 / HIPAA / GDPR** — no formal audit. ROI TBD.
- **SAML / SSO** — no SAML; OAuth login/link exists for Google, GitHub, and Microsoft (env-configured, self-service signup opt-in via `OAUTH_ALLOW_SIGNUP`).
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
| Frontend dist | ~694 KB raw (gzip ~212 KB) |

### Optimizations in place

- **gzip compression** — `Content-Encoding: gzip` on responses > 1 KB (~3x bandwidth reduction)
- **ETag / 304 revalidation** — `weak ETag` on every response
- **Pagination** — `?limit=&offset=` on top list endpoints (default 50, max 200)
- **Hot-path cache headers** — `Cache-Control: private, max-age=N` for `/api/me`, `/api/models`, `/api/bootstrap-status`
- **WebSocket frame batching** — 30 ms coalesce window for non-critical messages
- **Response cache** — 1-hour TTL with hourly sweeper for expired rows
- **Vendor chunk split** — 50 kB gzipped React bundle cached once; per-page chunks are mostly < 4 kB gzipped
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
| [SECURITY-SCORE-9.5.md](./SECURITY-SCORE-9.5.md) | Self-assessed hardening notes (not an independent audit) |
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
| **Visual workflow editor** | ✅ ~4.0k LoC, hand-rolled SVG | ❌ |
| **Slack first-class** | Future plugin | ✅ |
| **Standout feature** | **Visual workflow editor** | **Slack-first** |
| **Stars** | new | ~13k |

The right choice depends on whether you want a **workflow-first** tool (HELM) or a **chat-first** tool (QM). HELM has a stronger operational story (defense-in-depth, observability, deploy hardening); QM has a stronger community and Slack integration.

---

## License

[MIT](./LICENSE) — fork it, ship it, sell it. Attribution appreciated but not required.
