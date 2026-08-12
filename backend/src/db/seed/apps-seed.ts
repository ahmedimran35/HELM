// Apps seed (P7 of qm-parity, docs §qm-parity).
//
// Three demo apps land in the `apps` table the first time the server
// boots against an empty DB so the /apps admin page and the user-facing
// /my-apps gallery have something to show. Runs after migrations +
// runBootstrap + runSkillsSeed in `index.ts`.
//
// Idempotent: if the table already has rows we no-op. Re-running this
// against a non-empty table leaves existing data untouched.
//
// The `bundle_url` values point at the local /apps-bundles server (sibling
// PR wires the static bundle server). They double as "install URLs" for
// the apps-embed iframe route.

import { sql } from "../client.ts";

interface SeedApp {
  slug: string;
  name: string;
  description: string;
  bundle_url: string;
}

const SEED_APPS: SeedApp[] = [
  {
    slug: "standup",
    name: "Daily Standup",
    description:
      "Generate a standup update from your recent panel activity.",
    bundle_url: "/apps/standup-app/",
  },
  {
    slug: "notes",
    name: "Notes",
    description:
      "A fast, keyboard-friendly notepad tied to your user.",
    bundle_url: "/apps/notes-app/",
  },
  {
    slug: "inbox",
    name: "Inbox Triage",
    description:
      "See every recent message from every panel in one place. Star, archive, or reply with AI.",
    bundle_url: "/apps/inbox-app/",
  },
];

export interface AppsSeedResult {
  seeded: boolean;
  inserted: number;
}

export async function seedAppsIfEmpty(): Promise<AppsSeedResult> {
  const result = await sql.begin(async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM apps
    `;
    const count = Number(rows[0]?.count ?? "0");
    if (count > 0) {
      return { seeded: false, inserted: 0 };
    }
    let inserted = 0;
    for (const a of SEED_APPS) {
      await tx`
        INSERT INTO apps (slug, name, description, bundle_url, version, enabled)
        VALUES
          (${a.slug}, ${a.name}, ${a.description}, ${a.bundle_url},
           ${"0.1.0"}, ${true})
      `;
      inserted++;
    }
    return { seeded: true, inserted };
  });

  if (result.seeded) {
    console.log(
      `✓ apps seed: inserted ${result.inserted} demo app(s) (standup, notes, inbox)`,
    );
  } else {
    console.log("✓ apps seed: apps table non-empty, skipping seed");
  }
  return result;
}
