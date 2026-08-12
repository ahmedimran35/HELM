// Nav items — single source of truth for both the sidebar and any router
// guard. Marked adminOnly: true to be hidden for `user` role.
//
// Nav items — single source of truth for both the sidebar and any router
// guard. Marked adminOnly: true to be hidden for `user` role.

import type { Role } from "../auth/AuthContext";

/**
 * Logical grouping for the sidebar. The sidebar renders each group as a
 * collapsible section header with the group's items underneath. This breaks
 * up the otherwise-flat list of 13+ items into 5 natural chunks so users
 * can scan the sidebar without reading every label.
 *
 * - chat      what's on my mind right now (chat, home, panels, approvals)
 * - build     authoring reusable pieces (workspace, apps, skills, workflows)
 * - run       day-to-day ops (sandbox, watches, browser/voice/docs)
 * - discover  find things (search, kg, web-search)
 * - operate   metrics + settings (admin-leaning: perf, health, spend, settings)
 */
export type NavGroup = "chat" | "build" | "run" | "discover" | "operate";

export interface NavItem {
  path: string;
  label: string;
  adminOnly: boolean;
  /** Workspace-header breadcrumb tail, e.g. "CHAT", "PROVIDERS". */
  section: string;
  group: NavGroup;
  /** Optional short hint shown in the tooltip. */
  hint?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  // ── Group "Chat" — everyday conversation surfaces ─────────────────────
  { path: "/", label: "Home", adminOnly: false, section: "HOME", group: "chat", hint: "Dashboard + recent activity" },
  { path: "/chat", label: "Chat", adminOnly: false, section: "CHAT", group: "chat", hint: "1:1 chat with any model" },
  { path: "/panels", label: "Panels", adminOnly: false, section: "PANELS", group: "chat", hint: "Multiplayer rooms with shared agent" },
  { path: "/approvals", label: "Approvals", adminOnly: false, section: "APPROVALS", group: "chat", hint: "Pending agent requests waiting for your OK" },

  // ── Group "Build" — authoring reusable artifacts ─────────────────────
  { path: "/workspace", label: "Workspace", adminOnly: false, section: "WORKSPACE", group: "build", hint: "Memory · files · keychain · crons · posture" },
  { path: "/apps", label: "Apps", adminOnly: false, section: "APPS", group: "build", hint: "Your installed apps + catalog" },
  { path: "/skills", label: "Skills", adminOnly: true, section: "SKILLS", group: "build", hint: "Reusable agent behaviors" },
  { path: "/marketplace", label: "Marketplace", adminOnly: false, section: "MARKETPLACE", group: "build", hint: "Discover + install apps / templates / personas" },
  { path: "/workflows", label: "Workflows", adminOnly: false, section: "WORKFLOWS", group: "build", hint: "Visual workflow canvas" },

  // ── Group "Run" — day-to-day ops tools ─────────────────────────────
  { path: "/sandbox", label: "Sandbox", adminOnly: false, section: "SANDBOX", group: "run", hint: "Code execution environment" },
  { path: "/watches", label: "Watches", adminOnly: false, section: "WATCHES", group: "run", hint: "Scheduled + webhook triggers" },

  // ── Group "Discover" — find things ───────────────────────────────────
  { path: "/search", label: "Search", adminOnly: false, section: "SEARCH", group: "discover", hint: "Universal search across everything" },
  { path: "/kg", label: "Knowledge Graph", adminOnly: false, section: "KNOWLEDGE GRAPH", group: "discover", hint: "Entities + relationships from your chats" },
  { path: "/web-search", label: "Web Search", adminOnly: false, section: "WEB SEARCH", group: "discover", hint: "Live internet search" },

  // ── Group "Operate" — metrics + settings (admin-leaning) ───────────
  { path: "/perf", label: "Performance", adminOnly: false, section: "PERFORMANCE", group: "operate", hint: "Latency, cache hit rate, error rate" },
  { path: "/analytics", label: "Analytics", adminOnly: true, section: "ANALYTICS", group: "operate", hint: "Spend by model · top users · messages over time" },
  { path: "/spend-caps", label: "Spend Caps", adminOnly: false, section: "SPEND CAPS", group: "operate", hint: "Per-panel budget limits" },
  { path: "/health", label: "Health", adminOnly: false, section: "HEALTH", group: "operate", hint: "Harness status + latency" },
  { path: "/integrations", label: "Integrations", adminOnly: true, section: "INTEGRATIONS", group: "operate", hint: "Outbound webhooks (Discord, Slack, etc.)" },
  { path: "/providers", label: "Providers", adminOnly: true, section: "PROVIDERS", group: "operate", hint: "AI provider + model registry" },
  { path: "/memory-strategies", label: "Memory Strategies", adminOnly: true, section: "MEMORY STRATEGIES", group: "operate", hint: "Memory storage strategies (rows, summary, vector)" },
  { path: "/feedback", label: "Feedback", adminOnly: true, section: "FEEDBACK", group: "operate", hint: "Per-message thumbs + agent preferences" },
  { path: "/status", label: "Status", adminOnly: true, section: "STATUS", group: "operate", hint: "System health overview" },
  { path: "/requests", label: "Requests", adminOnly: true, section: "REQUESTS", group: "operate", hint: "Pending model access requests" },
  { path: "/connected-accounts", label: "Connected Accounts", adminOnly: false, section: "CONNECTED", group: "operate", hint: "OAuth providers + Slack workspace" },
  { path: "/settings", label: "Settings", adminOnly: false, section: "SETTINGS", group: "operate", hint: "Account, password, theme" },
] as const;

export function visibleNav(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "admin");
}

/** Group every nav item by its `group` field, preserving the in-array order. */
export function groupedNav(role: Role): Array<{ group: NavGroup; items: NavItem[] }> {
  const out: Array<{ group: NavGroup; items: NavItem[] }> = [
    { group: "chat", items: [] },
    { group: "build", items: [] },
    { group: "run", items: [] },
    { group: "discover", items: [] },
    { group: "operate", items: [] },
  ];
  const seen = new Set<NavGroup>();
  for (const item of NAV_ITEMS) {
    if (item.adminOnly && role !== "admin") continue;
    const bucket = out.find((b) => b.group === item.group);
    if (bucket) bucket.items.push(item);
  }
  // Drop empty groups
  return out.filter((b) => b.items.length > 0);
}

/** Human-readable label for a group, used in section headers. */
export function groupLabel(g: NavGroup): string {
  switch (g) {
    case "chat": return "Chat";
    case "build": return "Build";
    case "run": return "Run";
    case "discover": return "Discover";
    case "operate": return "Operate";
  }
}
