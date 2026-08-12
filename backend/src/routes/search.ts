// Global search backend — single endpoint that powers the Cmd+K command
// palette in the frontend. Returns a flat array of results, each tagged
// with a `kind` so the frontend can group and render appropriately.
//
// Sources queried (in order, with a hard cap on each so a heavy table
// can't drown everything else):
//   1. Pages — static navigation items, filtered by role.
//   2. Models — registry, name + display_name LIKE match.
//   3. Panels — name match for panels the user can see.
//   4. Users — username / name match (admin only — admins need it for
//      "invite / reset pw" flows; non-admins don't need to find other
//      users).
//   5. Actions — static list of shortcuts (new chat, new panel, etc.)
//      that don't navigate anywhere but perform an in-app action.
//
// Query semantics:
//   - The query is whitespace-trimmed; empty queries return a small
//     curated "starter" set (so the palette has content even before the
//     user types).
//   - Each result has a stable `id` and a `path` (or null for actions).
//   - We rank by simple starts-with > contains; the frontend keeps
//     the order we send.
//
// The endpoint is intentionally small. We don't need full-text search
// yet — ILIKE across the four columns is plenty at the volumes HELM is
// built for. When that stops being true, swap to tsvector + websearch_to_
// tsquery without changing the response shape.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";

const router = new Hono();
router.use("*", requireAuth);

type ResultKind = "page" | "model" | "panel" | "user" | "action";

interface Result {
  id: string;
  kind: ResultKind;
  title: string;
  subtitle?: string;
  path?: string | null;
  /** Visual hint for the renderer — secondary text colour or icon. */
  hint?: string;
  /** Optional badge shown at the right edge of the result row. */
  badge?: string;
}

/**
 * Each page entry records whether it's admin-only so the search endpoint
 * can filter the catalogue by the caller's role. Keep the paths in sync
 * with frontend/src/nav/items.ts.
 */
const STATIC_PAGES: Array<Result & { adminOnly: boolean }> = [
  { id: "page:/chat",          kind: "page", title: "Chat",          subtitle: "1:1 with any assigned model",                                path: "/chat",       adminOnly: false, badge: "�⌘C" },
  { id: "page:/panels",        kind: "page", title: "Panels",        subtitle: "Multiplayer rooms",                                          path: "/panels",     adminOnly: false, badge: "⇧⌘P" },
  { id: "page:/workspace",     kind: "page", title: "Workspace",     subtitle: "Memory · files · sandbox · keychain · crons · posture",      path: "/workspace",  adminOnly: false },
  { id: "page:/web-search",    kind: "page", title: "Web Search",    subtitle: "Real-time search via the configured provider",               path: "/web-search", adminOnly: false },
  { id: "page:/analytics",     kind: "page", title: "Analytics",     subtitle: "Spend · volume · top users (admin)",                         path: "/analytics",  adminOnly: true,  badge: "⇧⌘A" },
  { id: "page:/requests",      kind: "page", title: "Requests",      subtitle: "Pending access decisions (admin)",                          path: "/requests",   adminOnly: true },
  { id: "page:/providers",     kind: "page", title: "Providers",     subtitle: "Manage AI providers and model registry (admin)",             path: "/providers",  adminOnly: true },
  { id: "page:/integrations",  kind: "page", title: "Integrations",  subtitle: "Discord · Telegram · Slack webhooks (admin)",                path: "/integrations", adminOnly: true },
  { id: "page:/settings",      kind: "page", title: "Settings",      subtitle: "Account · users · websearch · logs",                         path: "/settings",   adminOnly: false, badge: "⇧⌘S" },
];

const STATIC_ACTIONS: Result[] = [
  { id: "action:new-chat", kind: "action", title: "New chat", subtitle: "Open the chat page with no active model", path: "/chat", hint: "action" },
  { id: "action:toggle-theme", kind: "action", title: "Toggle theme", subtitle: "Switch between dark and light", hint: "action" },
  { id: "action:sign-out", kind: "action", title: "Sign out", subtitle: "End the current session", hint: "action" },
];

function normalise(q: string): string {
  return q.trim().toLowerCase();
}

function matches(text: string, q: string): boolean {
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

// Naive ranking: starts-with > contains.
function rankScore(text: string, q: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - t.length;
  if (t.includes(q)) return 50 - t.length;
  return -1;
}

function pageVisible(path: string, role: "admin" | "user"): boolean {
  const item = STATIC_PAGES.find((p) => p.path === path);
  if (!item) return false;
  return !item.adminOnly || role === "admin";
}

router.get("/", async (c) => {
  const user = c.get("user");
  const q = normalise(c.req.query("q") ?? "");

  const results: Result[] = [];

  // 1. Pages — filter by role.
  for (const p of STATIC_PAGES) {
    if (!p.path || !pageVisible(p.path, user.role)) continue;
    const score = Math.max(
      rankScore(p.title, q),
      rankScore(p.subtitle ?? "", q),
    );
    if (q && score < 0) continue;
    results.push({ ...p, id: p.id, subtitle: p.subtitle, path: p.path, badge: p.badge });
  }

  // 2. Models — match name + display_name.
  if (q.length >= 1) {
    const modelRows = await sql<{
      id: string;
      external_id: string;
      display_name: string;
    }[]>`
      SELECT id, external_id, display_name
      FROM models
      WHERE state = 'active'
        AND (LOWER(external_id) LIKE ${"%" + q + "%"}
          OR LOWER(display_name) LIKE ${"%" + q + "%"})
      ORDER BY external_id ASC
      LIMIT 8
    `;
    for (const m of modelRows) {
      results.push({
        id: `model:${m.id}`,
        kind: "model",
        title: m.display_name || m.external_id,
        subtitle: m.external_id,
        path: `/chat?model=${m.id}`,
        badge: "MODEL",
      });
    }
  }

  // 3. Panels — name match, scoped to the user's visibility:
  //    - admin sees all panels
  //    - user sees only panels they belong to
  if (q.length >= 1) {
    const panelRows = user.role === "admin"
      ? await sql<{ id: string; name: string }[]>`
          SELECT id, name FROM panels
          WHERE LOWER(name) LIKE ${"%" + q + "%"}
          ORDER BY created_at DESC LIMIT 6
        `
      : await sql<{ id: string; name: string }[]>`
          SELECT p.id, p.name FROM panels p
          JOIN panel_members pm ON pm.panel_id = p.id
          WHERE pm.user_id = ${user.id}::uuid
            AND LOWER(p.name) LIKE ${"%" + q + "%"}
          ORDER BY p.created_at DESC LIMIT 6
        `;
    for (const p of panelRows) {
      results.push({
        id: `panel:${p.id}`,
        kind: "panel",
        title: p.name,
        subtitle: `Panel`,
        path: `/panels?panel=${p.id}`,
        badge: "PANEL",
      });
    }
  }

  // 4. Users — admin only.
  if (user.role === "admin" && q.length >= 1) {
    const userRows = await sql<{ id: string; username: string; name: string; role: string }[]>`
      SELECT id, username, name, role FROM users
      WHERE is_active = TRUE
        AND (LOWER(username) LIKE ${"%" + q + "%"}
          OR LOWER(name) LIKE ${"%" + q + "%"})
      ORDER BY name ASC
      LIMIT 6
    `;
    for (const u of userRows) {
      results.push({
        id: `user:${u.id}`,
        kind: "user",
        title: u.name,
        subtitle: `@${u.username}`,
        badge: u.role.toUpperCase(),
        path: `/settings/users?focus=${u.id}`,
      });
    }
  }

  // 5. Actions — only when query is short (or empty starter).
  if (q.length <= 2) {
    for (const a of STATIC_ACTIONS) {
      const score = Math.max(
        rankScore(a.title, q),
        rankScore(a.subtitle ?? "", q),
      );
      if (q && score < 0) continue;
      results.push(a);
    }
  }

  // Sort: actions last, otherwise by score desc.
  results.sort((a, b) => {
    if (a.kind === "action" && b.kind !== "action") return 1;
    if (b.kind === "action" && a.kind !== "action") return -1;
    return 0;
  });

  return c.json({
    query: q,
    results,
    counts: {
      page: results.filter((r) => r.kind === "page").length,
      model: results.filter((r) => r.kind === "model").length,
      panel: results.filter((r) => r.kind === "panel").length,
      user: results.filter((r) => r.kind === "user").length,
      action: results.filter((r) => r.kind === "action").length,
    },
  });
});

// ---------------------------------------------------------------------------
// Universal search (Tier 4: Discovery).
//
//   GET /api/search/universal?q=...&scope=panels|apps|memory|all&limit=N
//
// Hits every searchable surface in HELM:
//   - panels (by name + recent message content)
//   - apps     (admin catalogue)
//   - memory entries
//   - kg entities
//   - files
//   - knowledge docs
//   - marketplace entries
//
// Each result is tagged with a `kind` and ships a `snippet` excerpt + an
// optional `highlight` token to mark the hit. Ranking is per group:
//   exact (full-string) > prefix > word-boundary > contains > fuzzy.
//
// Scope values narrow the search to a single surface; defaults to "all".
// Returns grouped results so the UI can render headers.
// ---------------------------------------------------------------------------

type GroupKind =
  | "panel"
  | "app"
  | "memory"
  | "entity"
  | "file"
  | "knowledge"
  | "marketplace";

interface GroupResult {
  id: string;
  kind: GroupKind;
  title: string;
  subtitle?: string;
  path?: string;
  snippet?: string;
  highlight?: string;
  score: number;
  created_at?: string;
}

const SCOPES: ReadonlyArray<"all" | "panels" | "apps" | "memory"> = [
  "all",
  "panels",
  "apps",
  "memory",
];

// Naive but well-behaved ranking. Returns 0..100 — higher is better.
//   exact      — entire haystack equals needle
//   prefix     — word in haystack starts with needle
//   word       — needle occurs on a word boundary
//   contains   — needle occurs anywhere
//   fuzzy      — every char of needle appears in order (very loose)
function rank(haystack: string | null | undefined, needle: string): number {
  if (!needle) return 0;
  if (!haystack) return -1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n) || h.includes(" " + n)) return 80;
  // Word-boundary match
  const wordRx = new RegExp(`\\b${escapeRx(n)}\\b`);
  if (wordRx.test(h)) return 60;
  if (h.includes(n)) return 40;
  if (fuzzyMatch(h, n)) return 20;
  return -1;
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Subsequence check: every char of needle appears in order in haystack.
// This is the cheapest "fuzzy" approximation that still gives useful
// results when the user typos.
function fuzzyMatch(haystack: string, needle: string): boolean {
  let h = 0;
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, h);
    if (idx === -1) return false;
    h = idx + 1;
  }
  return true;
}

// Trim content around the first match so the UI can render a useful snippet.
function snippet(content: string, needle: string, contextChars = 60): string {
  if (!content) return "";
  if (!needle) return content.slice(0, 160);
  const lower = content.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx === -1) return content.slice(0, 160);
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + needle.length + contextChars);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

interface UniversalHit {
  group: GroupKind;
  results: GroupResult[];
}

router.get("/universal", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") ?? "").trim();
  const scopeRaw = (c.req.query("scope") ?? "all").toLowerCase();
  const scope = (SCOPES as readonly string[]).includes(scopeRaw) ? scopeRaw : "all";
  const limitPerGroup = Math.min(20, Math.max(1, Number(c.req.query("limit") ?? 8)));

  // If q is empty we don't run searches — return the empty grouped
  // response so the frontend can render the "Did you mean…" UI.
  const groups: Record<GroupKind, GroupResult[]> = {
    panel: [],
    app: [],
    memory: [],
    entity: [],
    file: [],
    knowledge: [],
    marketplace: [],
  };

  if (q.length === 0) {
    return c.json({ query: "", scope, total: 0, groups });
  }

  // ─── Panels (by name + recent message content) ─────────────────────────
  if (scope === "all" || scope === "panels") {
    const panelRows = user.role === "admin"
      ? await sql<{
          id: string;
          name: string;
          created_at: Date;
          snippet: string | null;
        }[]>`
          SELECT p.id, p.name, p.created_at,
                 (SELECT content FROM messages m WHERE m.panel_id = p.id ORDER BY m.created_at DESC LIMIT 1) AS snippet
          FROM panels p
        `
      : await sql<{
          id: string;
          name: string;
          created_at: Date;
          snippet: string | null;
        }[]>`
          SELECT p.id, p.name, p.created_at,
                 (SELECT content FROM messages m WHERE m.panel_id = p.id ORDER BY m.created_at DESC LIMIT 1) AS snippet
          FROM panels p
          JOIN panel_members pm ON pm.panel_id = p.id
          WHERE pm.user_id = ${user.id}::uuid
        `;
    for (const p of panelRows) {
      const score = Math.max(rank(p.name, q), rank(p.snippet ?? "", q));
      if (score < 0) continue;
      groups.panel.push({
        id: `panel:${p.id}`,
        kind: "panel",
        title: p.name,
        subtitle: "Panel",
        path: `/panels?panel=${p.id}`,
        snippet: snippet(p.snippet ?? "", q),
        highlight: q,
        score,
        created_at: new Date(p.created_at).toISOString(),
      });
    }
    groups.panel.sort((a, b) => b.score - a.score);
    groups.panel = groups.panel.slice(0, limitPerGroup);
  }

  // ─── Apps (catalogue) ──────────────────────────────────────────────────
  if (scope === "all" || scope === "apps") {
    // Apps: admins see all, users only enabled.
    const appRows = user.role === "admin"
      ? await sql<{
          id: string;
          slug: string;
          name: string;
          description: string;
        }[]>`SELECT id, slug, name, description FROM apps ORDER BY created_at DESC LIMIT 200`
      : await sql<{
          id: string;
          slug: string;
          name: string;
          description: string;
        }[]>`SELECT id, slug, name, description FROM apps WHERE enabled = TRUE ORDER BY created_at DESC LIMIT 200`;
    for (const a of appRows) {
      const score = Math.max(rank(a.name, q), rank(a.description, q));
      if (score < 0) continue;
      groups.app.push({
        id: `app:${a.id}`,
        kind: "app",
        title: a.name,
        subtitle: a.slug,
        path: `/apps?focus=${a.id}`,
        snippet: snippet(a.description, q),
        highlight: q,
        score,
      });
    }
    groups.app.sort((a, b) => b.score - a.score);
    groups.app = groups.app.slice(0, limitPerGroup);
  }

  // ─── Memory entries ────────────────────────────────────────────────────
  if (scope === "all" || scope === "memory") {
    const memRows = await sql<{
      id: string;
      text: string;
      scope: string;
      created_at: Date;
    }[]>`
      SELECT id, text, scope, created_at FROM memory_entries
      WHERE user_id = ${user.id}::uuid
      ORDER BY created_at DESC LIMIT 200
    `;
    for (const m of memRows) {
      const score = rank(m.text, q);
      if (score < 0) continue;
      groups.memory.push({
        id: `memory:${m.id}`,
        kind: "memory",
        title: m.text.slice(0, 60) + (m.text.length > 60 ? "…" : ""),
        subtitle: m.scope,
        path: `/workspace?memory=${m.id}`,
        snippet: snippet(m.text, q),
        highlight: q,
        score,
        created_at: new Date(m.created_at).toISOString(),
      });
    }
    groups.memory.sort((a, b) => b.score - a.score);
    groups.memory = groups.memory.slice(0, limitPerGroup);
  }

  // ─── KG entities ───────────────────────────────────────────────────────
  if (scope === "all") {
    const entRows = await sql<{
      id: string;
      name: string;
      kind: string;
    }[]>`SELECT id, name, kind FROM kg_entities WHERE user_id = ${user.id}::uuid`;
    for (const e of entRows) {
      const score = rank(e.name, q);
      if (score < 0) continue;
      groups.entity.push({
        id: `entity:${e.id}`,
        kind: "entity",
        title: e.name,
        subtitle: e.kind,
        path: `/kg?entity=${e.id}`,
        snippet: snippet(e.name, q),
        highlight: q,
        score,
      });
    }
    groups.entity.sort((a, b) => b.score - a.score);
    groups.entity = groups.entity.slice(0, limitPerGroup);
  }

  // ─── Files ─────────────────────────────────────────────────────────────
  if (scope === "all") {
    const fileRows = await sql<{
      id: string;
      name: string;
      path: string;
      updated_at: Date;
    }[]>`
      SELECT id, name, path, updated_at FROM files
      WHERE owner_user_id = ${user.id}::uuid
         OR panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid)
      ORDER BY updated_at DESC LIMIT 200
    `;
    for (const f of fileRows) {
      const score = Math.max(rank(f.name, q), rank(f.path, q));
      if (score < 0) continue;
      groups.file.push({
        id: `file:${f.id}`,
        kind: "file",
        title: f.name,
        subtitle: "file",
        path: `/workspace?file=${f.id}`,
        snippet: f.path,
        highlight: q,
        score,
        created_at: new Date(f.updated_at).toISOString(),
      });
    }
    groups.file.sort((a, b) => b.score - a.score);
    groups.file = groups.file.slice(0, limitPerGroup);
  }

  // ─── Knowledge docs ────────────────────────────────────────────────────
  if (scope === "all") {
    const docRows = await sql<{
      id: string;
      name: string;
      panel_id: string;
    }[]>`
      SELECT d.id, d.name, d.panel_id FROM knowledge_docs d
      WHERE d.panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid)
         OR ${user.role === "admin"}::boolean
      ORDER BY d.uploaded_at DESC LIMIT 200
    `;
    for (const d of docRows) {
      const score = rank(d.name, q);
      if (score < 0) continue;
      groups.knowledge.push({
        id: `knowledge:${d.id}`,
        kind: "knowledge",
        title: d.name,
        subtitle: "knowledge doc",
        path: `/panels?panel=${d.panel_id}`,
        snippet: snippet(d.name, q),
        highlight: q,
        score,
      });
    }
    groups.knowledge.sort((a, b) => b.score - a.score);
    groups.knowledge = groups.knowledge.slice(0, limitPerGroup);
  }

  // ─── Marketplace entries (visible to everyone) ─────────────────────────
  if (scope === "all") {
    const mktRows = await sql<{
      id: string;
      slug: string;
      name: string;
      description: string;
    }[]>`
      SELECT id, slug, name, description FROM marketplace_entries
      WHERE enabled = TRUE ORDER BY install_count DESC LIMIT 100
    `;
    for (const m of mktRows) {
      const score = Math.max(rank(m.name, q), rank(m.description, q), rank(m.slug, q));
      if (score < 0) continue;
      groups.marketplace.push({
        id: `marketplace:${m.id}`,
        kind: "marketplace",
        title: m.name,
        subtitle: m.slug,
        path: `/marketplace?id=${m.id}`,
        snippet: snippet(m.description, q),
        highlight: q,
        score,
      });
    }
    groups.marketplace.sort((a, b) => b.score - a.score);
    groups.marketplace = groups.marketplace.slice(0, limitPerGroup);
  }

  const total = Object.values(groups).reduce((acc, arr) => acc + arr.length, 0);
  return c.json({ query: q, scope, total, groups });
});

// Simple "did you mean?" suggestion: when the query has zero results,
// offer queries formed by removing the last word, then the first word.
router.get("/suggest", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") ?? "").trim();
  const suggestions: string[] = [];
  if (!q) return c.json({ suggestions });
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    suggestions.push(words.slice(0, -1).join(" "));
    suggestions.push(words.slice(1).join(" "));
    suggestions.push(words[Math.floor(words.length / 2)] ?? "");
  }
  // Always include the bare needle so the UI can retry with no prefix.
  if (!suggestions.includes(q)) suggestions.push(q);

  // Filter duplicates + blanks, capped at 5.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of suggestions) {
    const t = s.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 5) break;
  }
  // Hint: pulled from public panels + popular marketplace entries so
  // the suggestion row has meaningful content. Capped at 6 entries.
  const hints = await sql<{ name: string }[]>`
    SELECT name FROM marketplace_entries
    WHERE enabled = TRUE ORDER BY install_count DESC LIMIT 6
  `;
  return c.json({
    suggestions: out,
    popular: hints.map((h) => h.name),
  });
  // user is read indirectly through the suggest call from the universal
  // route — kept in the signature so future per-user hints are easy.
  void user;
});

export default router;
