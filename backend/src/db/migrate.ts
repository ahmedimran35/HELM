// Tiny migration runner. Looks for *.sql files in src/db/migrations/, sorts
// them lexicographically, and applies any not already recorded in the
// `schema_migrations` table. Each migration runs in a single transaction.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(HERE, "migrations");

async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function appliedSet(): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM schema_migrations`;
  return new Set(rows.map((r) => r.id));
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable();
  const already = await appliedSet();
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (already.has(id)) {
      skipped.push(id);
      continue;
    }
    const body = readFileSync(join(MIG_DIR, file), "utf8");
    // Each migration file is run inside its own transaction so a syntax
    // error in one file doesn't leave the DB in a half-applied state.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (id) VALUES (${id})`;
    });
    applied.push(id);
    console.log(`  ✓ applied ${id}`);
  }
  return { applied, skipped };
}

// CLI entrypoint: `bun src/db/migrate.ts`
if (import.meta.main) {
  try {
    const result = await runMigrations();
    if (result.applied.length === 0) {
      console.log(`✓ schema is up to date (${result.skipped.length} already applied)`);
    } else {
      console.log(`✓ applied ${result.applied.length} migration(s); ${result.skipped.length} already applied`);
    }
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error("✗ migration failed:", err);
    process.exit(1);
  }
}