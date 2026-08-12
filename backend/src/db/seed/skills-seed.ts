// Skills seed (docs §2.x, P3 of qm-parity).
//
// Three sample skills land in the `skills` table the first time the server
// boots against an empty DB so the admin has something to look at on the
// /skills page. Runs after migrations + runBootstrap in `index.ts`.
//
// Idempotent: if the table already has rows we no-op. Re-running this
// against a non-empty table leaves existing data untouched.

import { sql } from "../client.ts";

interface SeedSkill {
  name: string;
  description: string;
  body: string;
  kind: "prompt" | "tool" | "workflow";
  scope: "org" | "panel" | "user";
  tags: string[];
  version: string;
}

const SEED_SKILLS: SeedSkill[] = [
  {
    name: "Web Search",
    description: "Look up current info from the public web before answering.",
    body: `# Web Search

Use web_search to find current info when:

- the question references something that happened after your training cutoff
- the user asks about live data (prices, schedules, news, weather)
- a topic has shifted since you last saw it

Format the user's query, call web_search, then summarize the top 2–3 hits
with citations. Prefer official sources over aggregators.`,
    kind: "tool",
    scope: "org",
    tags: ["search", "research"],
    version: "0.1.0",
  },
  {
    name: "Code Review",
    description: "Review the following code for bugs and style.",
    body: `# Code Review

Review the following code for:

1. **Correctness** — does it do what the comment / docstring claims?
2. **Bugs** — off-by-one, nil/null, race conditions, swallowed errors.
3. **Style** — naming, indentation, dead code, over-clever patterns.
4. **Tests** — would you trust this without a test? What would you test?

Reply with a numbered list of findings. For each, quote the line, say
why it matters, and suggest a fix. Skip praise.`,
    kind: "prompt",
    scope: "org",
    tags: ["review", "engineering"],
    version: "0.1.0",
  },
  {
    name: "Daily Standup",
    description: "Generate a standup update from the last 24h of work.",
    body: `# Daily Standup

Generate a standup update from the last 24h of work.

Produce three sections, each ≤3 bullets:

- **Yesterday** — what I shipped / closed
- **Today** — what I'm picking up next
- **Blockers** — anything I need help on

Skip any section that's empty. Keep it scannable; the reader is in a hurry.`,
    kind: "workflow",
    scope: "org",
    tags: ["standup", "process"],
    version: "0.1.0",
  },
];

export interface SkillsSeedResult {
  seeded: boolean;
  inserted: number;
}

export async function runSkillsSeed(): Promise<SkillsSeedResult> {
  const result = await sql.begin(async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM skills
    `;
    const count = Number(rows[0]?.count ?? "0");
    if (count > 0) {
      return { seeded: false, inserted: 0 };
    }
    let inserted = 0;
    for (const s of SEED_SKILLS) {
      await tx`
        INSERT INTO skills
          (name, description, body, kind, scope, tags, version)
        VALUES
          (${s.name}, ${s.description}, ${s.body},
           ${s.kind}, ${s.scope}, ${s.tags}, ${s.version})
      `;
      inserted++;
    }
    return { seeded: true, inserted };
  });

  if (result.seeded) {
    console.log(
      `✓ skills seed: inserted ${result.inserted} starter skill(s) (Web Search, Code Review, Daily Standup)`,
    );
  } else {
    console.log("✓ skills seed: skills table non-empty, skipping seed");
  }
  return result;
}
