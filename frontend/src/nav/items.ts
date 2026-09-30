// Nav items — single source of truth for both the sidebar and any router
// guard. Marked adminOnly: true to be hidden for `user` role.

import type { Role } from "../auth/AuthContext";

/**
 * Logical grouping for the sidebar. The sidebar renders each group as a
 * collapsible header with the group's items underneath.
 *
 * Four groups, ordered by intent rather than by internal module:
 *
 * - core    what you reach for constantly: conversation + find (chat, panels,
 *           approvals, search, knowledge graph, web search)
 * - build   authoring and running things: workspace, workflows, apps,
 *           marketplace, sandbox, watches
 * - system  observe and configure your own account: health, analytics,
 *           spend caps, connected accounts, settings
 * - admin   instance administration. Every item here is adminOnly, so the
 *           whole group disappears for `user` role instead of being mixed
 *           into the everyday list.
 */
export type NavGroup = "core" | "build" | "system" | "admin";

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
  // ── Group "Core" — everyday conversation + discovery ─────────────────
  { path: "/", label: "Home", adminOnly: false, section: "HOME", group: "core", hint: "Dashboard + recent activity" },
  { path: "/chat", label: "Chat", adminOnly: false, section: "CHAT", group: "core", hint: "1:1 chat with any model" },
  { path: "/panels", label: "Panels", adminOnly: false, section: "PANELS", group: "core", hint: "Multiplayer rooms with shared agent" },
  { path: "/approvals", label: "Approvals", adminOnly: false, section: "APPROVALS", group: "core", hint: "Pending agent requests waiting for your OK" },
  { path: "/search", label: "Search", adminOnly: false, section: "SEARCH", group: "core", hint: "Universal search across everything" },
  { path: "/web-search", label: "Web Search", adminOnly: false, section: "WEB SEARCH", group: "core", hint: "Live internet search" },

  // ── Group "Build" — authoring reusable artifacts ─────────────────────
  { path: "/workspace", label: "Workspace", adminOnly: false, section: "WORKSPACE", group: "build", hint: "Memory · files · keychain · crons · posture" },
  { path: "/workflows", label: "Workflows", adminOnly: false, section: "WORKFLOWS", group: "build", hint: "Visual workflow canvas" },
  { path: "/apps", label: "Apps", adminOnly: false, section: "APPS", group: "build", hint: "Your installed apps + catalog" },
  { path: "/marketplace", label: "Marketplace", adminOnly: false, section: "MARKETPLACE", group: "build", hint: "Discover + install apps / templates / personas" },
  { path: "/sandbox", label: "Sandbox", adminOnly: false, section: "SANDBOX", group: "build", hint: "Code execution environment" },
  { path: "/swarm", label: "Agents Swarm", adminOnly: true, section: "AGENTS SWARM", group: "build", hint: "Experimental multi-model debate panel" },
  { path: "/watches", label: "Watches", adminOnly: false, section: "WATCHES", group: "build", hint: "Scheduled + webhook triggers" },

  // ── Group "System" — observe + configure your own account ────────────
  { path: "/health", label: "Health", adminOnly: false, section: "HEALTH", group: "system", hint: "Harness status + latency" },
  { path: "/analytics", label: "Analytics", adminOnly: false, section: "ANALYTICS", group: "system", hint: "Latency · usage · cost · top models" },
  { path: "/spend-caps", label: "Spend Caps", adminOnly: false, section: "SPEND CAPS", group: "system", hint: "Per-panel budget limits" },
  { path: "/connected-accounts", label: "Connected Accounts", adminOnly: false, section: "CONNECTED", group: "system", hint: "OAuth identity providers" },
  { path: "/settings", label: "Settings", adminOnly: false, section: "SETTINGS", group: "system", hint: "Account, password, theme" },

  // ── Group "Admin" — instance administration (hidden for `user`) ──────
  { path: "/skills", label: "Skills", adminOnly: true, section: "SKILLS", group: "admin", hint: "Reusable agent behaviors" },
  { path: "/providers", label: "Providers", adminOnly: true, section: "PROVIDERS", group: "admin", hint: "AI provider + model registry" },
  { path: "/requests", label: "Requests", adminOnly: true, section: "REQUESTS", group: "admin", hint: "Pending model access requests" },
] as const;

/** Render order for the sidebar groups. Any group with no visible items is
 *  dropped, so `admin` simply does not appear for `user` role. */
const GROUP_ORDER: readonly NavGroup[] = ["core", "build", "system", "admin"];

export function visibleNav(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "admin");
}

/** Group every nav item by its `group` field, in GROUP_ORDER. */
export function groupedNav(role: Role): Array<{ group: NavGroup; items: NavItem[] }> {
  const out: Array<{ group: NavGroup; items: NavItem[] }> = GROUP_ORDER.map((group) => ({
    group,
    items: [],
  }));
  for (const item of NAV_ITEMS) {
    if (item.adminOnly && role !== "admin") continue;
    const bucket = out.find((b) => b.group === item.group);
    if (bucket) bucket.items.push(item);
  }
  // Drop empty groups (e.g. `admin` for a non-admin caller).
  return out.filter((b) => b.items.length > 0);
}

/** Human-readable label for a group, used in section headers. */
export function groupLabel(g: NavGroup): string {
  switch (g) {
    case "core": return "Core";
    case "build": return "Build";
    case "system": return "System";
    case "admin": return "Admin";
  }
}
