// Wipe everything in the helm DB and re-run migrations. DEV ONLY — refuses
// to run unless DATABASE_URL points to a non-production host. This is the
// shortcut for "I broke my schema, start over."

import { sql } from "./client.ts";
import { runMigrations } from "./migrate.ts";

function isSafeToReset(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  // Refuse if it looks like a hosted URL (has a real hostname we don't
  // recognize, contains "prod", "aws", "rds", etc.) — anything else is fair.
  const banned = [/\.rds\.amazonaws\.com/, /\.supabase\.co/, /neon\.tech/, /\.prod\./, /prod-/];
  if (banned.some((re) => re.test(url))) return false;
  if (!/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/.test(url) && !url.includes("helm")) return false;
  return true;
}

if (!isSafeToReset()) {
  console.error("✗ refusing to reset — DATABASE_URL doesn't look like a dev host");
  process.exit(1);
}

if (import.meta.main) {
  console.log("⚠  dropping all tables in helm DB…");
  // Drop in reverse-dependency order via CASCADE.
  await sql.unsafe(`
    DROP TABLE IF EXISTS
      audit_log, integrations, budgets, quotas, tool_posture, crons,
      keychain_grants, sandboxes, files, memory_entries, knowledge_docs,
      messages, panel_members, panels, personas, access_requests,
      model_access, models, providers, sessions, users, bootstrap_meta,
      schema_migrations
    CASCADE;
  `);
  console.log("✓ dropped; re-running migrations");
  const result = await runMigrations();
  console.log(`✓ applied ${result.applied.length} migration(s)`);
  await sql.end();
  process.exit(0);
}