// Marketplace seed — 12 starter catalogue entries that show up in the
// marketplace the very first time the server boots against an empty DB.
// Mirrors `seedAppsIfEmpty` and `runSkillsSeed` in spirit: idempotent, run
// after migrations in `index.ts`.
//
// Entry kinds (per 0009 migration):
//   skill_pack          — a bundle of skills auto-loadable on a panel
//   app                 — a small web app bundle the user can install
//   workflow_template   — a starter graph for the workflow builder
//   persona             — a system-prompt preset the user can adopt

import { sql } from "../client.ts";

interface SeedEntry {
  kind: "skill_pack" | "app" | "workflow_template" | "persona";
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  install_count: number;
  rating: number;
  manifest: Record<string, unknown>;
}

const ENTRIES: SeedEntry[] = [
  {
    kind: "skill_pack",
    slug: "academic-research",
    name: "Academic Research",
    description:
      "Cite-grounded research skills: literature search, source ranking, citation formatting (APA / MLA / Chicago).",
    version: "0.2.1",
    author: "HELM Labs",
    tags: ["research", "writing", "citations"],
    install_count: 1284,
    rating: 4.8,
    manifest: {
      skills: [
        { name: "literature-search", kind: "tool" },
        { name: "citation-format", kind: "prompt" },
      ],
    },
  },
  {
    kind: "skill_pack",
    slug: "code-review",
    name: "Code Review",
    description:
      "Read a diff and produce a focused review: correctness, security, style, and test gaps.",
    version: "1.0.0",
    author: "HELM Labs",
    tags: ["engineering", "review", "security"],
    install_count: 2210,
    rating: 4.7,
    manifest: {
      skills: [
        { name: "diff-review", kind: "tool" },
        { name: "security-audit", kind: "prompt" },
      ],
    },
  },
  {
    kind: "skill_pack",
    slug: "customer-support",
    name: "Customer Support",
    description:
      "Triage inbounds, draft empathetic replies, surface escalation candidates automatically.",
    version: "0.9.0",
    author: "Community",
    tags: ["support", "writing"],
    install_count: 832,
    rating: 4.5,
    manifest: {
      skills: [{ name: "support-triage", kind: "workflow" }],
    },
  },
  {
    kind: "app",
    slug: "standup-app",
    name: "Daily Standup",
    description:
      "Generate a standup update from your recent panel activity. Pinned to your user.",
    version: "0.1.0",
    author: "HELM Labs",
    tags: ["ops", "standup"],
    install_count: 514,
    rating: 4.4,
    manifest: {
      bundle_url: "/apps/standup-app/",
      permissions: ["panel:read", "user:read"],
    },
  },
  {
    kind: "app",
    slug: "notes-app",
    name: "Notes",
    description:
      "A fast, keyboard-friendly notepad tied to your user. Markdown friendly, autosaved.",
    version: "0.1.0",
    author: "HELM Labs",
    tags: ["writing", "notes"],
    install_count: 740,
    rating: 4.6,
    manifest: {
      bundle_url: "/apps/notes-app/",
      permissions: ["user:read", "user:write"],
    },
  },
  {
    kind: "app",
    slug: "inbox-app",
    name: "Inbox Triage",
    description:
      "See every recent message from every panel in one place. Star, archive, or reply with AI.",
    version: "0.1.0",
    author: "HELM Labs",
    tags: ["ops", "inbox"],
    install_count: 622,
    rating: 4.3,
    manifest: {
      bundle_url: "/apps/inbox-app/",
      permissions: ["panel:read", "user:read"],
    },
  },
  {
    kind: "workflow_template",
    slug: "morning-brief",
    name: "Morning Brief",
    description:
      "Every weekday at 08:00: summarise overnight panel activity, post to your daily panel.",
    version: "0.1.0",
    author: "HELM Labs",
    tags: ["schedule", "summary"],
    install_count: 411,
    rating: 4.5,
    manifest: {
      trigger: { kind: "schedule", cron: "0 8 * * 1-5" },
      nodes: [
        { id: "trigger", type: "schedule" },
        { id: "summarise", type: "agent_run", uses: "harness" },
        { id: "post", type: "panel_message" },
      ],
      edges: [
        { from: "trigger", to: "summarise" },
        { from: "summarise", to: "post" },
      ],
    },
  },
  {
    kind: "workflow_template",
    slug: "webhook-to-panel",
    name: "Webhook → Panel",
    description:
      "Receive an HTTP POST and route the payload into a panel as a message. Useful for inbound integrations.",
    version: "0.1.0",
    author: "Community",
    tags: ["webhook", "integration"],
    install_count: 268,
    rating: 4.2,
    manifest: {
      trigger: { kind: "webhook" },
      nodes: [
        { id: "webhook", type: "webhook" },
        { id: "post", type: "panel_message" },
      ],
      edges: [{ from: "webhook", to: "post" }],
    },
  },
  {
    kind: "workflow_template",
    slug: "watch-and-summarise",
    name: "Watch & Summarise",
    description:
      "Subscribe to an RSS / HTTP source, summarise new entries, post to a panel.",
    version: "0.1.0",
    author: "HELM Labs",
    tags: ["watch", "summary"],
    install_count: 312,
    rating: 4.4,
    manifest: {
      trigger: { kind: "watch" },
      nodes: [
        { id: "watch", type: "watch" },
        { id: "summarise", type: "agent_run" },
        { id: "post", type: "panel_message" },
      ],
      edges: [
        { from: "watch", to: "summarise" },
        { from: "summarise", to: "post" },
      ],
    },
  },
  {
    kind: "persona",
    slug: "engineer-mentor",
    name: "Engineer Mentor",
    description:
      "Patient senior engineer voice. Prefers clear explanations, runtime traces, and runnable code samples.",
    version: "0.3.0",
    author: "Community",
    tags: ["mentor", "engineering"],
    install_count: 945,
    rating: 4.7,
    manifest: {
      system_prompt:
        "You are a senior engineer who mentors through clear explanations and runnable code samples. Prefer working snippets over prose; narrate trade-offs.",
    },
  },
  {
    kind: "persona",
    slug: "exec-briefer",
    name: "Exec Briefer",
    description:
      "Lead with the bottom line, then the evidence. Two short paragraphs, no filler.",
    version: "0.2.0",
    author: "HELM Labs",
    tags: ["writing", "exec"],
    install_count: 612,
    rating: 4.5,
    manifest: {
      system_prompt:
        "You brief executives. Lead with one bold bottom-line sentence, then 2 short paragraphs of evidence. No fluff, no hedging.",
    },
  },
  {
    kind: "persona",
    slug: "design-critic",
    name: "Design Critic",
    description:
      "Reads UI screenshots for hierarchy, contrast, and rhythm. Calls out accessibility issues explicitly.",
    version: "0.1.0",
    author: "Community",
    tags: ["design", "accessibility"],
    install_count: 358,
    rating: 4.4,
    manifest: {
      system_prompt:
        "You critique interface designs. Focus on visual hierarchy, contrast, and rhythm. Always call out accessibility issues when present.",
    },
  },
];

export interface MarketplaceSeedResult {
  seeded: boolean;
  inserted: number;
}

export async function seedMarketplaceIfEmpty(): Promise<MarketplaceSeedResult> {
  const result = await sql.begin(async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM marketplace_entries
    `;
    const count = Number(rows[0]?.count ?? "0");
    if (count > 0) {
      return { seeded: false, inserted: 0 };
    }
    let inserted = 0;
    for (const e of ENTRIES) {
      // `tags` arrives as a string[], which postgres.js serialises to
      // a text[] column. Manifest is JSONB.
      await tx`
        INSERT INTO marketplace_entries
          (kind, slug, name, description, version, author, tags, install_count, rating, manifest, enabled)
        VALUES
          (${e.kind}, ${e.slug}, ${e.name}, ${e.description}, ${e.version},
           ${e.author}, ${e.tags}, ${e.install_count}, ${e.rating},
           ${sql.json(JSON.parse(JSON.stringify(e.manifest)))}, TRUE)
      `;
      inserted++;
    }
    return { seeded: true, inserted };
  });

  if (result.seeded) {
    console.log(
      `✓ marketplace seed: inserted ${result.inserted} entries (kind mix = ${ENTRIES.map((e) => e.kind).join(", ")})`,
    );
  } else {
    console.log("✓ marketplace seed: catalogue non-empty, skipping seed");
  }
  return result;
}
