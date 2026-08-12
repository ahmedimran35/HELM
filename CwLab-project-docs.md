# HELM — Project Documentation

A governed, multiplayer AI workspace for a company. Admin provisions AI providers and controls who gets access to what; users chat 1:1 with assigned models and collaborate with agents inside shared project panels. Built as one codebase with role-based rendering — admin and user see the same shell, different capabilities.

This document is the build reference for Claude Code: what we're building, exactly how it should look, every piece of functionality, the data model behind it, a phased build order with a suggested number of parallel agents per phase, and how to test the result once it's built.

---

## 1. Design System

**Feel:** an ops/dispatch console — precise, technical, data-dense. Not a generic SaaS blue gradient, not a cream-and-terracotta AI template.

### Color tokens
| Token | Hex | Use |
|---|---|---|
| `bg` | `#0B0E12` | App background |
| `panel` | `#12161B` | Sidebar surface |
| `panelAlt` | `#171C22` | Cards, table headers, active row states |
| `border` | `#262B32` | Default borders |
| `borderSoft` | `#1D2229` | Hairline dividers |
| `text` | `#EDEAE2` | Primary text (warm off-white, not pure white) |
| `textMuted` | `#8A9098` | Secondary text |
| `textFaint` | `#4E5560` | Timestamps, IDs, tertiary labels |
| `brass` | `#C9A227` | Signature accent — active states, primary actions, brand mark |
| `brassSoft` | `#8A7220` | Brass borders / dimmed brass fills |
| `teal` | `#4C9C90` | Success / active / online states |
| `rust` | `#B5533C` | Denials, warnings, budget-overrun alerts |

### Typography
- **Display** — Space Grotesk (headers, brand wordmark "HELM"), weights 500–700
- **Body** — Inter, weights 400–600
- **Mono** — IBM Plex Mono, for IDs, timestamps, call-signs, code-like data — this is deliberate: it's what makes the product feel like an ops console instead of a generic dashboard

### Signature device
**Call-sign IDs** on every entity — models (`MDL-01`), panels (`PNL-02`), requests (`REQ-14`) — rendered in mono with brass badges. This is the one memorable visual idea; keep everything else quiet and disciplined around it.

### Layout
- Fixed 240–260px left sidebar (brand mark, role indicator, nav, account footer) + flexible right workspace canvas
- Workspace header shows a breadcrumb-style path (`WORKSPACE / CHAT`) in mono caps
- Sub-navigation within a section uses underlined mono tabs, not nested sidebars
- Mobile: sidebar collapses behind a hamburger overlay below `md` breakpoint

---

## 2. Full Feature Spec

### 2.1 Shell & roles
- Single app, single component tree. A `role` field (`admin` | `user`) gates rendering and API authorization — never two separate codebases.
- Left nav: **Chat, Panels, Workspace, Analytics\*, Requests\*, Providers\*, Integrations\*, Settings** (\* = admin-only, hidden entirely for users, not just disabled)

### 2.1a Login & role routing
One login page for everyone — there's no separate "admin login" URL. Whoever hits the site or the app's IP/domain sees the same login form.
1. User submits credentials → server authenticates and looks up that account's `role` in the `users` table.
2. Server issues a session (or JWT) with the role embedded as a claim.
3. Client reads the role from the session response and renders the shell accordingly: admin role → full nav (including admin-only items); user role → restricted nav. This is the same conditional rendering described in 2.1, just triggered immediately post-login rather than on every subsequent load.
4. The role check also happens server-side on every API call, not just at login — the client-side redirect is a UX convenience, the actual authorization boundary is enforced per-request against the session's role claim. A user token hitting an admin-only endpoint must still get `403` regardless of what the UI shows.
5. If the role is ever changed by another admin while a user is logged in, the change takes effect on their next request (server checks the current role from the database or a short-lived cache, not a value baked into a long-lived token) — don't let a demoted admin keep admin access until their token expires.

### 2.1b Account provisioning (no public sign-up)
There is no public registration page — this is a closed, invite-only system by design.
- The **first** admin account is seeded from environment variables at deploy time (`ADMIN_USERNAME`, `ADMIN_PASSWORD`) — see §8 for the exact bootstrap flow. That's the only account that exists on a fresh deployment.
- Every other account — admin or user — is created **from inside the admin panel** by an existing admin, under Settings → Users (see 2.10). Admin sets a username and an initial password (or the system generates one), then shares it with the person out of band.
- A user can change their own password once logged in (Settings → Account).
- If a user loses their password, they cannot self-service reset it — only an admin can regenerate it, from Settings → Users. The regenerated password should be shown to the admin once and force a change on the user's next login.

### 2.2 Chat
- 1:1 conversation with any model the user has been assigned
- Session list (left column within the view) + active thread + input bar
- Streaming responses token-by-token (not full-block replies)

### 2.3 Panels (multiplayer rooms)
- Admin creates a panel, invites specific users — not global, explicit membership
- Real-time group chat (WebSocket) — all members plus the panel's assigned agent share one thread
- Agent is an addressable participant, not a separate 1:1 chat — its replies are visible to everyone in the panel
- **Knowledge tab** — documents uploaded to the panel are chunked and indexed (RAG); the panel's agent retrieves from them when answering. Scoped per panel, not global.
- Admin controls per panel: membership, assigned model/persona, per-panel quota/budget, per-panel logs

### 2.4 Workspace (scoped per-user environment)
- **Memory** — durable facts the agent has picked up about this user, each tagged with its source (a chat, a specific panel) and timestamp
- **Files** — a personal + panel-scoped file area
- **Sandbox** — a durable execution environment per user (status, CPU/memory, uptime, restart control) for code execution / tool use
- **Keychain** — a *view* of which credentials/tools this user's agent can invoke (masked values, "granted by admin" — never raw secrets)
- **Crons** — scheduled agent jobs (name, cron schedule, last/next run, enabled toggle)
- **Posture** — per-tool approval mode: **Strict** pauses that tool for admin/user approval every time it's invoked; **Auto** lets a classifier screen it and run without pausing. Set per tool (web search, code execution, file write, Slack post, email send), not globally.

### 2.5 Access control loop
- Only admin adds providers (OpenAI, Anthropic, NVIDIA NIM, any OpenAI-compatible endpoint) — paste base URL + API key, click **Fetch Models**, registry populates
- Admin assigns specific models to specific users or panels
- User sees all models; unassigned ones show a **Request Access** button → creates a pending request → admin sees it in a queue → **Approve/Deny** → on approve, access is granted immediately
- Same request/approve flow applies at the panel level, not just per-user

### 2.6 Governance
- **Quotas** — per-user message limits (numeric or unlimited)
- **Budgets** — per-user dollar spend cap, computed from token usage × provider pricing, with an in-app warning as the user approaches the limit
- **Analytics** (admin) — spend-by-model chart, message-volume-over-time chart, a top-users leaderboard, and a budget-overrun alert banner
- **Model comparison playground** (admin, inside Providers) — send one test prompt to two candidate models, view responses side by side, before assigning either

### 2.7 Logs (admin only, password-gated)
Re-enter a password (step-up auth) even though already logged in as admin — this is the most sensitive screen.
- **Activity tab** — every chat/tool/provider action: timestamp, user, target (model or panel), action type, token count
- **Sessions tab** — per login: login time, active/ended status, session duration, IP address, and which sections of the app that user visited during the session

### 2.8 Personas (admin, under Settings)
Reusable system-prompt presets ("Support Triage Bot", "Code Reviewer") that can be assigned to a panel instead of a raw model with default behavior.

### 2.9 Integrations (admin)
Outbound webhooks to **Discord, Telegram, and Slack** — configurable per service:
- Webhook URL
- Which events fire to it (access requests, budget alerts, panel activity)
- Connect/disconnect + test-send

### 2.10 Settings
- **Account** — name, role, and (for users) quota + spend bars, plus a change-password form for any logged-in user
- **Users** (admin) — create a user account (username + initial/generated password), list all accounts with role and status, regenerate a user's password on request (shown once, forces change on next login), deactivate an account
- **Models** — the registry, same content whether reached from Settings or elsewhere in the app
- **Personas** (admin)
- **Logs** (admin)

---

## 3. Admin vs. User capability matrix

| Capability | Admin | User |
|---|---|---|
| Add/edit AI providers | ✅ | ❌ |
| Create user accounts | ✅ | ❌ |
| Reset another user's password | ✅ | ❌ |
| Change own password | ✅ | ✅ |
| Fetch models from a provider | ✅ | ❌ |
| Assign a model to a user/panel | ✅ | ❌ |
| Request access to a model | — | ✅ |
| Approve/deny access requests | ✅ | ❌ |
| Chat with assigned models | ✅ | ✅ |
| Create/manage panels & membership | ✅ | ❌ (can participate if invited) |
| Upload panel knowledge docs | ✅ | ✅ (if panel member) |
| View own Workspace (memory/files/sandbox/keychain/crons) | ✅ | ✅ |
| Set tool posture | ✅ (any user) | ✅ (own, if permitted) |
| View Analytics | ✅ | ❌ |
| View audit logs (password-gated) | ✅ | ❌ |
| Set quotas/budgets | ✅ | ❌ (sees own only) |
| Manage personas | ✅ | ❌ |
| Configure integrations | ✅ | ❌ |

---

## 4. Data model (entities)

```
users            (id, name, username, password_hash, role, must_change_password, created_at, created_by)
providers        (id, type, base_url, api_key_encrypted, added_by)
models           (id, provider_id, external_id, display_name, state)
model_access     (user_id | panel_id, model_id, granted_at, granted_by)
access_requests  (id, user_id, model_id, panel_id?, status, requested_at, decided_by, decided_at)
panels           (id, name, agent_model_id, persona_id?, created_by)
panel_members    (panel_id, user_id)
messages         (id, user_id?, panel_id?, model_id, role, content, tokens, created_at)
quotas           (user_id, message_limit, period)
budgets          (user_id, dollar_limit, period)
memory_entries   (user_id, text, source_type, source_id, created_at)
files            (id, owner_user_id?, panel_id?, name, size, path, updated_at)
sandboxes        (user_id, status, cpu_pct, mem_pct, last_reset_at)
keychain_grants  (user_id, credential_name, scope, granted_by)
crons            (id, user_id, name, schedule, last_run_at, next_run_at, enabled)
tool_posture     (user_id | panel_id, tool_name, posture)
knowledge_docs   (id, panel_id, name, chunk_count, uploaded_at)
personas         (id, name, description, system_prompt)
integrations     (id, service, webhook_url, events[], connected)
audit_log        (id, user_id, target, action, tokens, created_at)
sessions         (id, user_id, login_at, logout_at, ip, sections_visited[])
```

---

## 5. Suggested stack

- **Runtime:** Bun + TypeScript throughout
- **Backend:** Bun HTTP server or Hono, Postgres (primary store), Redis (quota counters, WebSocket pub/sub)
- **Realtime:** WebSocket for panel chat and live status
- **Frontend:** React + Vite, Tailwind (restyled per the design tokens above, not left default), shadcn/ui as a base only
- **Auth:** session-based with role claims; a separate step-up check specifically for the log viewer
- **Deploy:** existing Ubuntu VPS

Architecture rule: the backend exposes one internal HTTP/WebSocket API. The admin dashboard and user dashboard are both thin clients over that same API — never fork logic between them.

---

## 6. Build phases (for Claude Code)

Each phase lists a suggested number of parallel Claude Code agents/sessions. "Agents" here means separate Claude Code sessions working on largely independent parts of the codebase in parallel — split by module boundary, not by file, so they don't collide on the same files. Sequence phases in order; only parallelize *within* a phase once its shared foundation (schema, API contracts) is settled.

### Phase 0 — Foundation (1 agent)
Repo scaffold, Postgres schema + migrations, auth skeleton (sessions, roles), single login page with server-side role lookup and role-based shell routing (see 2.1a), base API server, CI setup. **Do not parallelize** — everything else depends on this being stable first.

### Phase 1 — Core Gateway (2–3 agents)
- Agent A: Provider adapters (OpenAI, Anthropic, NVIDIA NIM, generic OpenAI-compatible) + model registry + fetch endpoint
- Agent B: Access request/approval workflow + quota enforcement
- Agent C: 1:1 chat + streaming
Ships as a usable slice on its own.

### Phase 2 — Multiplayer layer (2 agents)
- Agent A: Panels + WebSocket real-time chat + membership
- Agent B: Knowledge base / RAG ingestion + retrieval per panel

### Phase 3 — Scoped Workspace (2–3 agents)
- Agent A: Sandbox provisioning + status/execution
- Agent B: Memory + Keychain (grant model + masked display)
- Agent C: Crons + per-tool Posture enforcement

### Phase 4 — Governance & Ops (2 agents)
- Agent A: Budgets/spend tracking + Analytics endpoints (charts, leaderboard)
- Agent B: Personas + model comparison playground

### Phase 5 — Integrations (1 agent)
Discord/Telegram/Slack webhook dispatch, event subscription config, test-send.

### Phase 6 — Audit & Sessions (1 agent)
Activity log, session tracking (login time, IP, sections visited), password step-up gate.

### Phase 7 — Frontend build-out (2 agents, once each backend phase's API contract is frozen)
- Agent A: Design system components (tokens, nav, tables, badges, charts)
- Agent B: Page assembly per view, wiring to the real API

### Phase 8 — Hardening pass (1 agent)
Rate limiting, secret encryption at rest, input validation, RBAC middleware audit across every endpoint.

**Total across the project: roughly 2–3 agents running concurrently at any given time**, never more — beyond that, coordination overhead (shared schema changes, merge conflicts) usually costs more than the parallelism gains. Give each agent a clearly bounded module and a shared `CLAUDE.md` describing the schema and API conventions so they don't diverge.

---

## 7. Environment & bootstrap

No public sign-up route exists anywhere in this app. Every account is either seeded at deploy time or created by an admin from inside the app.

### `.env` variables
```
ADMIN_USERNAME=...
ADMIN_PASSWORD=...        # plaintext here only at deploy time — hashed on first boot, never stored or logged in plaintext
DATABASE_URL=...
REDIS_URL=...
SESSION_SECRET=...
```

### First-boot bootstrap flow
1. On server start, check if any row exists in `users`.
2. If the table is empty, create exactly one account from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, hash the password immediately, role = `admin`.
3. If `users` already has rows, **ignore** `ADMIN_USERNAME`/`ADMIN_PASSWORD` entirely — don't re-seed or overwrite an existing admin on every restart. This prevents a stale `.env` from silently resetting a real admin's password after they've already changed it.
4. From that point on, the `.env` admin credentials are only a recovery mechanism in principle (e.g. wiping the `users` table intentionally); the normal path for adding accounts is the admin panel, not the `.env` file.

### Creating users (post-bootstrap)
- Admin goes to Settings → Users → **Create user**, sets a username, and either sets an initial password or has the system generate one.
- That username/password is handed to the person outside the app (Slack DM, in person — not emailed in plaintext).
- On the new user's first login, `must_change_password` is true, forcing a password change before they can do anything else.

### Password reset (lost password)
- No "forgot password" self-service flow — a user who's locked out contacts an admin.
- Admin goes to Settings → Users, finds the account, clicks **Reset Password** → system generates a new one-time password, shown once to the admin.
- `must_change_password` is set true again, so the user is forced to set their own password on next login.

## 8. Testing plan (post-development)

### 8.1 Unit tests
- Quota/budget calculation logic
- Provider adapter response parsing (mock each provider's `/models` and chat response shape)
- Tool posture resolution (strict vs auto per tool per user)

### 8.2 Integration tests (API level)
For every endpoint, test both roles:
- Admin-only endpoints return `403` for a user token
- Provider fetch endpoint returns the correct model list shape and handles a failed/slow endpoint gracefully
- Access request → approve → model becomes usable for that user, in that order, atomically
- Quota/budget enforcement actually blocks a request once exceeded (not just displays a warning)

### 8.3 End-to-end tests (Playwright or similar)
Script the full loop each mockup screen represents:
1. Log in as an admin account and confirm the full nav renders; log in as a user account on the same login page and confirm admin-only nav items are absent — both from the same URL, routed purely by the account's role
2. Admin logs in → adds a provider → fetches models → assigns one to a test user
3. User logs in → sees the assigned model as active, an unassigned one shows Request Access
4. User requests access → admin sees it in the queue → approves → user's model list updates without a page reload
5. Admin creates a panel, invites two test users → both see real-time messages from each other and the panel agent
6. Admin uploads a doc to a panel's Knowledge tab → agent response reflects retrieved content
7. User approaches quota/budget limit → warning appears → next request blocked once truly exceeded
8. Admin opens Logs → gated by password even though already authenticated → both Activity and Sessions tabs show correct data
9. Admin connects a Discord/Slack/Telegram webhook → triggers a test event → external message arrives

### 8.4 Security-specific checks
- Confirm there is no public sign-up/registration route reachable, from any URL
- Confirm restarting the server with a populated `users` table does not re-seed or overwrite the existing admin from `.env`
- Confirm `ADMIN_PASSWORD` is never logged or stored in plaintext post-bootstrap
- Confirm a newly created user is forced to change their password on first login, and a password-reset target is forced to change it on their next login
- Confirm API keys are never returned in any API response body (not even to admin) after initial save — only masked
- SSRF protection: admin-supplied provider base URLs can't be used to hit internal network addresses
- Session/step-up auth for Logs can't be bypassed by direct route access
- Verify a user token can never read another user's memory, files, or keychain entries, even by guessing IDs

### 8.5 Load/concurrency tests
- Multiple simultaneous WebSocket connections in one panel — no message duplication or drop
- Concurrent quota decrements from the same user (race condition check — quota should never go negative or double-charge)
- Provider fetch timeout handling under a slow/unresponsive endpoint

### 8.6 Manual QA checklist
Walk every nav item as both admin and user, confirm:
- [ ] Nav item visibility matches role
- [ ] Every button in the mockup has a real handler (nothing silently does nothing)
- [ ] Every empty state (no panels yet, no requests pending, no logs) renders a sensible message, not a blank screen
- [ ] Design tokens applied consistently — no default Tailwind blue leaking through anywhere
- [ ] Responsive down to mobile width, sidebar collapses correctly
- [ ] Keyboard focus visible on every interactive element

---

*Reference: the interactive mockup (`dashboard-mockup.jsx`) built earlier in this project should be treated as the visual source of truth for Phase 7 — same color tokens, same component patterns, same nav structure.*
