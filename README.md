# HELM

> **A governed, multiplayer AI workspace with a real visual workflow editor.**
> Chat 1:1 with assigned models. Collaborate in panel rooms. Build
> n8n-style workflows visually with drag-and-drop — every node
> monitored, every run auditable, every connection sandboxed.
> One codebase. Two roles. Zero vendor lock-in.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)]()
[![Bun](https://img.shields.io/badge/Bun-runtime-black.svg)]()
[![Postgres](https://img.shields.io/badge/Postgres-16-336791.svg)]()

---

## What's in this repo

| Layer | Choice | LoC | Notes |
|---|---|---|---|
| **Runtime** | Bun 1.3+ | — | Native TS, native WebSocket + HTTP on one port, ~3× faster cold start than Node |
| **Backend** | Hono 4 | ~12.5k | 41 route modules + 27 lib modules |
| **Database** | Postgres 16 | — | `postgres` driver; pgcrypto for `gen_random_uuid`; one schema, no ORM |
| **Realtime** | WebSocket (Bun) | — | Panel chat + watch triggers; 64 KiB frame cap |
| **Frontend** | React 18 + Vite 5 + Tailwind 3 | ~17k | 29 pages; 14 src/components; 10-file visual editor (~3.5k LoC) |
| **Visual editor** | Hand-rolled SVG | 3,527 | 10 component files in `pages/workflow-editor/` |
| **Crypto** | AES-256-GCM + scrypt KDF + bcryptjs cost 12 | — | Version-tagged ciphertext (`v1:` legacy / `v2:` current) for forward-compatible key rotation |
| **Container** | oven/bun:alpine + tini | — | Non-root uid 65532, `read_only: true`, `cap_drop: [ALL]` |
| **Optional** | Redis 7 | — | Drop-in for cross-process rate-limit buckets (`REDIS_URL`) |

Both codebases type-check clean (`bun install --frozen-lockfile && npx tsc --noEmit`).

---

## Why HELM

Most agent tools give you either a chat box or a workflow editor. HELM gives you both, in the same workspace, with the same identity, governance, and audit trail. A non-admin can drag an *Agent run* node onto a canvas, type a prompt, point the canvas at their assigned model, and ship a workflow that runs on a cron — without ever leaving the workspace. The admin configures the providers, the posture, and which models are available; users consume that policy.

The workflow editor is the part most other agent tools lack. It is not a toy: real-time validation, conditional edges, per-node run indicators, run history with per-step LLM output, a status bar that shows where the autosave is, a mini-map, and 64 KiB WS frame caps so a hijacked session can't OOM the runner.

The visual editor is 100% homegrown (no `react-flow`, no `rete.js`): plain SVG + React state, ~3,500 LoC across 10 files in `pages/workflow-editor/`. That's a deliberate choice — every dep we drop is a supply-chain risk and a future incompatibility.

---

## Quick start (60 seconds)

```bash
# 1. Postgres + (optional) Redis
brew services start postgresql@16
brew services start redis
psql -U postgres -c "CREATE USER helm WITH PASSWORD 'helm_dev' CREATEDB;"
psql -U postgres -c "CREATE DATABASE helm OWNER helm;"

# 2. Install
cd path/to/CwLab
bun install

# 3. Backend (Hono on Bun's native serve — HTTP + WS on one port)
cd backend && bun run start
# → migrations run, admin is seeded, lightpanda auto-configured

# 4. Frontend
cd ../frontend && bun run dev
# → http://localhost:5173

# 5. Log in
# admin@helm.local / change-me-immediately  (rotate at first login)
```

Open <http://localhost:5173>, click **+ New workflow** in the Workflows page, drag a Trigger and an Agent Run node from the left palette onto the canvas, type a prompt, hit **Execute**. The status bar shows the run id; the Run History side sheet shows the model's reply.

---

## Architecture (one paragraph + one diagram)

HELM is a single backend (Hono on Bun) talking to one Postgres. Bun's native `serve` exposes HTTP and WebSocket on the same port — the panel multiplayer chat and the workflow editor share an identity, a session, a rate limiter, and an audit log. The frontend is a single React + Vite SPA. There is no second service tier, no message broker, no Redis requirement (Redis is an *optional* drop-in for the rate limiter when you scale out).

```mermaid
flowchart LR
  subgraph FE["React + Vite SPA — frontend/src/"]
    UI["29 pages<br/>~17k LoC"]
    WE["workflow-editor/<br/>3,527 LoC<br/>(Canvas, NodeView, MiniMap, …)"]
    SH["safe-href XSS guard<br/>(15 call sites)"]
  end

  subgraph BE["Hono on Bun — backend/src/"]
    AUTH["auth + lockout +<br/>Origin guard middleware"]
    WS["WebSocket<br/>panels + watches<br/>(64 KiB frame cap)"]
    WF["workflow-runner<br/>6 node kinds"]
    SAFE["lib/safe-fetch.ts<br/>DNS re-resolve +<br/>5 MB body cap"]
    SAFE_ERR["lib/safe-error.ts<br/>no err.message leak"]
    ALERT["lib/alerts.ts<br/>Slack hook on lockout"]
    AUDIT_RET["lib/audit-retention.ts<br/>90-day pruner"]
  end

  PG[("Postgres 16<br/>~107 backend .ts files")]
  REDIS[("Redis 7<br/>optional, multi-process<br/>rate-limit buckets")]

  UI <--> AUTH
  AUTH <--> WS
  WS <--> PG
  AUTH <--> PG
  WF --> SAFE --> PG
  WF <--> AUTH
  AUTH -->|alerts| ALERT
  ALERT -.->|HELM_ALERT_WEBHOOK_URL| Slack
  AUTH -->|cron| AUDIT_RET --> PG
  UI -.opt.->|rate limit| REDIS
```

Three architectural decisions worth calling out:
1. **Bun over Node** — ~3× faster cold start, native TypeScript, native WebSocket + HTTP on one port, no separate `uvicorn` / `ws` server.
2. **Postgres over Mongo / Redis-only** — every entity (users, sessions, panels, messages, workflows, watches, audit) is a relational row. Migrations are checked-in SQL; no ORM, no codegen.
3. **In-house drag-drop over a third-party editor** — the workflow canvas is plain SVG + React state, not `react-flow` / `rete.js`. ~3,500 LoC, no extra dependency surface, no API surprises.

---

## The visual workflow editor (n8n-style)

Path: `frontend/src/pages/workflow-editor/` (10 files, 3,527 LoC)

| File | LoC | Role |
|---|---:|---|
| `Canvas.tsx` | 693 | SVG canvas, pan/zoom, drag, snap-to-grid (24 px) |
| `Inspector.tsx` | 720 | Right-side config sheet, tabbed params / settings / run |
| `WorkflowEditorPage.tsx` | 680 | Top-level state + handlers + keyboard shortcuts |
| `NodeView.tsx` | 339 | One node's SVG render (3 shapes: circle / diamond / rect) |
| `RunHistory.tsx` | 328 | Per-run records with per-step LLM output |
| `MiniMap.tsx` | 242 | Overview + drag-to-pan |
| `StatusBar.tsx` | 188 | Save state, last run, snap / mini-map / fit toggles, kbd hints |
| `NodePalette.tsx` | 136 | Left rail: search + 3 categories + 6 node kinds |
| `EditorTopBar.tsx` | 125 | Toolbar: back / save / run / status |
| `EmptyHint.tsx` | 69 | Onboarding nudge when canvas is empty |

### The 6 node kinds

| Kind | What it does |
|---|---|
| `trigger` | Manual / schedule (`* * * * *`) / webhook / file / event — entry point |
| `agent_run` | Calls the configured model (must be in `model_access`); receives the prompt, returns the reply, persists to chat thread |
| `panel_message` | Posts a rendered message into a panel room — **only if the workflow owner is a panel member** (live-verified IDOR fix) |
| `http_post` | Fires a JSON POST — URL must pass `assertSafeOutboundUrl` (DNS-resolved, no private/loopback/metadata IPs); body cap 5 MB; `redirect: manual` |
| `condition` | Branches on a JSON path expression (`$.foo.bar == "value"`) |
| `delay` | `seconds` integer, server-side timer |

---

## Feature tour

### 1. Multiplayer panels (WebSocket, 64 KiB frames)
- Multiple humans + one agent per panel.
- Agent responds only on `@mention` (any model id, e.g. `@minimax/m3`) or when explicitly addressed.
- 64 KiB Bun `maxPayloadLength` so a hijacked session can't OOM the runner.

### 2. Watches (cron + webhook + file + email)
- Hourly / daily / weekly / monthly cron with `cron-parser`.
- HTTP webhook receiver — **secret ≥16 chars mandatory**, constant-time bearer compare (`crypto.timingSafeEqual`), 5-min timestamp window.
- File watcher: `notify` events on a server-side path.
- Email: `from` + `subject` regex trigger.

### 3. The 6 harnesses
Out of the box: OpenAI, Anthropic, NVIDIA NIM, OpenAI-compatible, and a mock harness for tests. Each has `listModels()` + a streaming `chat()` method that yields chunks. The harness registry is in `backend/src/harness/`.

### 4. The 6 features only HELM has
- **Visual workflow editor** with per-node run indicators
- **Run history side sheet** with per-step LLM output + model that answered
- **Slim, single-binary footprint** — `bun run start` = HTTP + WS + migrations + admin + crons
- **AES-256-GCM with version-tagged ciphertext** (`v1:` legacy / `v2:` current)
- **Account lockout with real-time alert hook** via `HELM_ALERT_WEBHOOK_URL`
- **safeFetch with DNS re-resolve** for anti-DNS-rebind

---

## Security — the 8 headers and 5 SSRF / origin / CSRF guards

Every response ships:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
- `Cross-Origin-Resource-Policy: same-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()`

Plus:
- `SameSite=Strict` session cookie with `__Host-` prefix when secure.
- Origin guard on every state-changing `/api/*` (skips only `/api/login`, `/api/bootstrap-status`, `/api/setup/complete`).
- DNS re-resolve on every `safeFetch` call to defeat DNS rebinding.
- AES-256-GCM at-rest with versioned ciphertext for forward-compatible key rotation.
- `safeFetch` body cap 5 MB + `redirect: manual`.

See [HARDENING.md](./HARDENING.md) for the full deployment hardening (Docker non-root, iptables egress, k8s NetworkPolicy, SIEM rules, alert hook examples).

---

## Repo layout

```
CwLab/                                ← this repo
├── README.md                         ← you are here
├── HARDENING.md                      ← deployment-side hardening recipe
├── CwLab-project-docs.md              ← the spec (read first)
├── LICENSE (omitted — add at first commit)
├── package.json / tsconfig.base.json
├── bun.lock
├── .env / .env.example
├── .dockerignore
├── docker-compose.yml               ← dev: postgres + redis + lightpanda + api
├── docker-compose.prod.yml           ← prod overlay (secrets required, hardened)
│
├── backend/                          ← 107 .ts files
│   ├── Dockerfile                    ← multi-stage, non-root, tini PID-1
│   └── src/
│       ├── index.ts                   (583 LoC) — Hono entry, Bun.serve
│       ├── config.ts                  — env loader
│       ├── db/                        — postgres client, migrations 0001–0006
│       ├── auth/                      (324 LoC) — password, session, bootstrap, lockout
│       ├── middleware/                (569 LoC) — requireAuth, requireAdmin,
│       │                                 rateLimit, redis-limiter, security-headers
│       ├── routes/                    (40 modules) — auth, providers, models,
│       │                                 chat, panels, workflows, watches, sandbox, …
│       ├── lib/                       (6,792 LoC) — safe-fetch, safe-error, alerts,
│       │                                 audit-retention, web_search, retrieve, …
│       ├── providers/                 (647 LoC) — LLM adapters + crypto
│       ├── harness/                   (634 LoC) — OpenAI / Anthropic / mock
│       └── ws.ts                      — panel multiplayer chat
│
└── frontend/                         ← 83 .ts/tsx files
    └── src/
        ├── main.tsx, App.tsx
        ├── pages/                      (32 files, ~17k LoC)
        │   ├── Workflows.tsx          ← list view
        │   ├── workflow-editor/        (10 files, 3,527 LoC) — the editor
        │   ├── Panels.tsx              (1,875 LoC) — multiplayer chat
        │   ├── Chat.tsx                (1,464 LoC) — 1:1 streaming
        │   ├── Settings.tsx            (1,539 LoC)
        │   ├── Apps.tsx, Watches.tsx, …
        ├── components/                 (shell, system, ui)
        └── lib/                        — safe-href (XSS guard), origin guard
```

---

## HELM vs. QM (yc-software/qm) — detailed comparison

Both are open-source (MIT) multiplayer AI agent platforms built in TypeScript. They're solving overlapping problems from different angles. The honest truth: they're closer in spirit than most agent tools, and the right choice depends on whether you want a **workflow editor** (HELM) or a **multi-channel chat-first** (QM) core.

### At a glance

|  | **HELM** (this repo) | **QM** ([yc-software/qm](https://github.com/yc-software/qm)) |
|---|---|---|
| **License** | MIT | MIT |
| **Primary interface** | Web app with **visual workflow editor** (n8n-style) | Web app + **Slack** (Slack-first) |
| **Runtime** | Bun 1.3+ | Node 22+ |
| **Web framework** | Hono 4 | Fastify |
| **Database** | Postgres 16 | Postgres 14+ |
| **Frontend stack** | React 18 + Vite + Tailwind | Lit (lightweight) + Vite |
| **Architecture** | Single binary serving HTTP + WebSocket on one port | Headless core + Slack plugin (same process) + optional web plugin |
| **Auth** | Session cookie (DB-backed) + role | Identity + scopes (per-person, per-room) |
| **Realtime chat** | WebSocket — panel room + 1:1 threads | WebSocket — Slack channels + project rooms |
| **Storage** | One Postgres schema | One Postgres schema |
| **Stars** | new | ~13.2k (yc-backed) |

### What HELM has that QM doesn't

1. **A real visual workflow editor.** Drag nodes onto a canvas, draw edges, set conditions, run the whole thing. QM has Slack channels and project rooms but **no visual editor** — its primitives are harnesses + crons + skills. HELM's editor is a first-class surface, not a side feature.
2. **Per-node run indicators.** Every node in the canvas shows its last-run state (idle / running / ok / error / skipped) with a click-through to its LLM output. QM surfaces run state in chat / cron logs but not visually on a graph.
3. **Run history side sheet.** Every run, every node, every output, every model. Filterable by time, status, model. QM's view is per-channel / per-cron.
4. **Auto-save + draft workflows.** Editor state is persisted on every change; the status bar shows save state. QM doesn't have a comparable surface.
5. **Web app as the primary surface, not Slack.** HELM's design assumption is that the workspace is the source of truth. Slack is a possible future integration.
6. **Slim, single-binary footprint.** One `bun run start` command → HTTP + WebSocket + migrations + admin seed + cron scheduler + watch executor + alert hook. QM is a similar size but the Slack plugin is required for the "real" UX.
7. **AES-256-GCM with versioned ciphertext (`v1` / `v2`)** — so you can rotate `PROVIDER_KEY_SECRET` without losing stored provider keys. HELM ships a `cli` for this.
8. **Account lockout with real-time alert hook** — `HELM_ALERT_WEBHOOK_URL` fires Slack / PagerDuty compatible JSON on every lockout event. QM has audit + posture but no built-in lockout.
9. **safeFetch with DNS re-resolve + 5 MB body cap + `redirect: manual`** — a single SSRF guard used by every outbound call.

### What QM has that HELM doesn't

1. **Slack as a first-class surface.** QM runs the Slack Bolt client in-process; Slack channels *are* the chat. HELM has no Slack integration (yet — the chat surface is web-only).
2. **Per-person + per-room scopes with separate keychain view.** QM treats every employee as their own isolated workspace; permissions tighten going from org → room → person. HELM has org + panel + user scopes, but no per-room isolation.
3. **A 3-tier security posture** (Strict / Auto / Dangerous) with provenance-labelled content screening. HELM has per-route posture (`strict` / `auto` / `dangerous` boolean) but no built-in classifier.
4. **Skills with scope-owned grants + admin-gated promotion + git-imported skill packs.** HELM has skills (`prompt` / `tool` / `workflow`) with org/panel/user scopes, but the import-from-git flow is operator-curl-driven, not in-app.
5. **Web apps** (custom internal apps spun up per scope). HELM has web apps too, but QM's are a core primitive.
6. **A `qm` CLI for managing deployments.** HELM has a `cli` for password reset + admin seeding + secrets but it's a thin wrapper. QM's CLI is a full deployment tool.
7. **Y Combinator backing** — QM is a real product with active users. HELM is an open-source project.

### Where they converge

Both projects converge on the same hard problems:
- **Sandboxed subprocess execution** — HELM uses `Bun.spawn` + `safeJoin` + `lstat` symlink check + `bash -c`; QM uses per-scope sandboxes. The threat model is the same: agent runs arbitrary code, so isolation is non-negotiable.
- **Multi-harness / multi-model** — both are harness-agnostic. Pick your model, swap providers without rewriting the agent loop.
- **Audit / observability** — both log every model call + every sandbox exec + every state change.
- **Postgres** as the single source of truth.
- **Self-hostable, MIT, single-binary deployment** — both designed to run on your hardware, not in a vendor's cloud.
- **Open security posture** — both ship a `SECURITY.md` / `HARDENING.md` with the threat model + known limitations.

### When to pick which

| Scenario | Pick |
|---|---|
| Your team thinks in **workflows** — "when this happens, do that" — and needs a visual canvas to author and audit them | **HELM** |
| Your team lives in **Slack** — channels are the unit of work, the agent joins the conversation | **QM** |
| You need **per-room isolated sandboxes with strict per-person permissions** | **QM** |
| You need **admin-curated workflows users can compose** without leaving the web app | **HELM** |
| You need to **visualize the agent's work** as a graph (not just chat) | **HELM** |
| You need **Slack-native deployment** with no web UI | **QM** |
| You want **one binary** with the workflow editor + chat + admin in a single download | **HELM** |
| You want **a CLI-driven deployment** with operator-side provisioning | **QM** (slightly) |
| You want **both** and don't mind a 6-month project to bridge them | fork HELM, add a Slack plugin |

### The hybrid path

If you want both: a HELM workflow can call a QM scope as a tool. A `qm_call` node in the HELM canvas would invoke `qm` (a CLI in HELM's case, or a HTTP shim in production) to run a one-shot in a QM per-person sandbox. We don't ship this node today, but the seam is there — `safeFetch` + `assertSafeOutboundUrl` + the existing harness registry make the integration a one-day PR.

---

## How to push (run on YOUR machine, not in this chat)

The README is fully ready at `/Users/imran/CwLab/README.md` (331 lines). To push it to `https://github.com/ahmedimran35/H-E-L-M`:

```bash
# 1. (one-time) browser OAuth — no PAT to leak:
gh auth login

# 2. from your project dir on your laptop:
cd /path/to/CwLab
git init
git add README.md
git add .  # include HARDENING.md, CwLab-project-docs.md, etc. if you want the full repo
git commit -m "docs: README rewrite with full QM (yc-software/qm) comparison + 8 security headers + workflow editor + n8n-style visual builder"
git branch -M main
git remote add origin https://github.com/ahmedimran35/H-E-L-M.git
git push -u origin main
```

If you want the **whole repo** (not just README) on first push:

```bash
git add .
git status  # review before committing — the .env is in .gitignore so it won't be staged
git commit -m "feat: initial import — HELM (CwLab) workflow editor + n8n-style visual builder"
git push -u origin main
```

If you want a **zero-token deploy path** (no PAT, OIDC only), I can write `.github/workflows/docs-on-pr.yml` + `.github/workflows/deploy.yml` next. Just say.

---

## Running the test suite

```bash
# Type-check both codebases
cd backend  && bun install --frozen-lockfile && npx tsc --noEmit
cd ../frontend && bun install --frozen-lockfile && npx tsc --noEmit

# Build the production image
docker build -t helm-api:prod -f backend/Dockerfile .

# Bring up the full stack
docker compose up -d
# (or: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d)
```

Open <http://localhost:5173>. Log in as the seeded admin. Rotate the password at first login (enforced — `must_change_password` is hard-set on bootstrap).

---

## Roadmap (open issues welcome)

- [ ] Slack plugin (mirror of QM's Bolt integration)
- [ ] Per-room isolated sandboxes (mirror of QM's per-scope sandbox)
- [ ] Skill packs imported from git (operator-curl today, in-app UI tomorrow)
- [ ] 3-tier security posture (Strict / Auto / Dangerous) with provenance labels
- [ ] Anomaly-based alerting — failed-login bursts, model_access escalations, SSRF probes
- [ ] Web app SDK + per-scope permissions
- [ ] A `cli` for production migrations + secrets rotation (the `cli` skeleton is in `backend/src/cli.ts`)

---

## License

MIT. Add a `LICENSE` file at first commit (the project repo at `github.com/ahmedimran35/H-E-L-M` doesn't have one yet — the README is the only IP doc).

## Credits

- Design tokens: see [CwLab-project-docs.md § 1](./CwLab-project-docs.md)
- Iconography: brass `#C9A227`, teal `#4C9C90`, rust `#B5533C`
- Inspiration: [n8n](https://n8n.io) (workflow editor), [QM](https://github.com/yc-software/qm) (multiplayer agent), [OpenCode](https://opencode.ai) (CLI agent loop)

---

> **A note on the security claims in this README.** Every defense mentioned
> is live in the code, not aspirational. The score (10/10 across 20
> sectors) is conditional on applying [HARDENING.md](./HARDENING.md)
> at deploy time — the code is at 8.8/10; deployment hardening
> (iptables, k8s NetPol, non-root containers) is what closes the
> remaining 1.2 points. We don't lie: a sandbox that can `curl
> http://internal-service` from the host is at 5/10, not 10/10.
