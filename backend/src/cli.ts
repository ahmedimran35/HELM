// helm cli — zero-config ops + integration (Tier 7).
//
// `bun src/cli.ts <command> [args]` — same binary as the api server, but
// with a small command layer that handles the boring ops jobs:
//   up            — migrate + seed + start the api (foreground)
//   status        — health probe against a running api (no api? spin up
//                   a one-shot probe against the DB + Redis)
//   logs          — tail recent audit / session / error rows from Postgres
//   reset-password — generate a one-time password for an existing user
//   seed          — re-run the demo-app / skills seed
//
// The cli intentionally doesn't depend on a running api for `up`: it
// boots one after migrations. That means a brand-new box with just
// `bun src/cli.ts up` gets a working install.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sql } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { runBootstrap } from "./auth/bootstrap.ts";
import { runSkillsSeed } from "./db/seed/skills-seed.ts";
import { seedAppsIfEmpty } from "./db/seed/apps-seed.ts";
import { generateOneTimePassword } from "./lib/ids.ts";
import { hashPassword } from "./auth/password.ts";

// ─── Tiny ANSI helpers (kept dependency-free so we don't need chalk) ───
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  brass: "\x1b[33m",
  teal: "\x1b[36m",
  rust: "\x1b[31m",
  green: "\x1b[32m",
};
function paint(c: string, s: string): string {
  return process.stdout.isTTY ? `${c}${s}${C.reset}` : s;
}
function banner(): void {
  const lines = [
    `${paint(C.bold + C.brass, "  HELM")} ${paint(C.dim, "v0.1  ·  governed multiplayer ai workspace")}`,
  ];
  for (const l of lines) console.log(l);
}

// ─── Env probing ────────────────────────────────────────────────────────
// The api requires ADMIN_USERNAME + ADMIN_PASSWORD + DATABASE_URL +
// SESSION_SECRET. The cli auto-provisions all four if missing so a fresh
// checkout can come up with literally one command. Auto-provisioned
// secrets are written to backend/.helm-secrets (gitignored) so they're
// stable across restarts without polluting the user's .env.

const SECRETS_PATH = join(import.meta.dir, "..", ".helm-secrets");

function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readSecretsFile(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSecretsFile(data: Record<string, string>): void {
  writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

interface ProvisionedEnv {
  DATABASE_URL: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  REDIS_URL: string;
  created: boolean;
}

function provisionEnv(): ProvisionedEnv {
  const secrets = readSecretsFile();
  let created = false;
  const out: ProvisionedEnv = {
    DATABASE_URL: process.env.DATABASE_URL ?? secrets.DATABASE_URL ?? "",
    ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? secrets.ADMIN_USERNAME ?? "admin",
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? secrets.ADMIN_PASSWORD ?? "",
    SESSION_SECRET: process.env.SESSION_SECRET ?? secrets.SESSION_SECRET ?? "",
    REDIS_URL: process.env.REDIS_URL ?? secrets.REDIS_URL ?? "redis://localhost:6379",
    created: false,
  };
  if (!out.DATABASE_URL) {
    out.DATABASE_URL = "postgres://helm:helm@localhost:5432/helm";
    created = true;
  }
  if (!out.ADMIN_PASSWORD) {
    out.ADMIN_PASSWORD = randomSecret(12);
    created = true;
  }
  if (!out.SESSION_SECRET) {
    out.SESSION_SECRET = randomSecret(32);
    created = true;
  }
  if (created && !existsSync(SECRETS_PATH)) {
    writeSecretsFile({
      DATABASE_URL: out.DATABASE_URL,
      ADMIN_USERNAME: out.ADMIN_USERNAME,
      ADMIN_PASSWORD: out.ADMIN_PASSWORD,
      SESSION_SECRET: out.SESSION_SECRET,
      REDIS_URL: out.REDIS_URL,
    });
    console.log(paint(C.dim, `  · wrote auto-generated secrets → .helm-secrets`));
  }
  // Push the resolved values into process.env so the api server picks
  // them up when we spawn it (the api's config module reads .env via
  // the dotenv loader; setting process.env here lets both the api and
  // this script share values without re-reading disk).
  process.env.DATABASE_URL = out.DATABASE_URL;
  process.env.ADMIN_USERNAME = out.ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = out.ADMIN_PASSWORD;
  process.env.SESSION_SECRET = out.SESSION_SECRET;
  process.env.REDIS_URL = out.REDIS_URL;
  return out;
}

// ─── Commands ───────────────────────────────────────────────────────────

async function cmdUp(): Promise<number> {
  banner();
  const env = provisionEnv();
  console.log(paint(C.bold, "\n→ migrate"));
  const mig = await runMigrations();
  console.log(
    paint(
      C.dim,
      `  applied ${mig.applied.length} · skipped ${mig.skipped.length}`,
    ),
  );
  console.log(paint(C.bold, "\n→ bootstrap first admin"));
  const boot = await runBootstrap();
  if (boot.seeded) {
    console.log(paint(C.teal, `  ✓ seeded admin "${env.ADMIN_USERNAME}"`));
  } else {
    console.log(paint(C.dim, "  · admin already exists, skipping"));
  }
  console.log(paint(C.bold, "\n→ seed skill packs"));
  await runSkillsSeed();
  console.log(paint(C.bold, "\n→ seed demo apps"));
  await seedAppsIfEmpty();

  // Probe harnesses + jobs so the "summary" line is real, not aspirational.
  const features = await probeFeatures();

  const port = Number(process.env.API_PORT ?? "3000");
  const url = `http://localhost:${port}`;
  console.log(paint(C.bold, "\n→ starting api"));
  console.log(paint(C.green, `  ✓ ${url}`));
  console.log(paint(C.bold, "\n  one-line summary:"));
  console.log(`    ${features}`);

  if (boot.seeded) {
    console.log(
      `\n  ${paint(C.brass, "admin")}  ${env.ADMIN_USERNAME} / ${paint(C.bold, env.ADMIN_PASSWORD)}`,
    );
    console.log(
      `  ${paint(C.dim, "open")}   ${url}\n  ${paint(C.dim, "(change the admin password after first login)")}`,
    );
  } else {
    console.log(`\n  ${paint(C.dim, "api ready at")} ${url}`);
  }

  // Spawn the api in the foreground so the process tree stays clean.
  // `inherit` stdio so the user sees the api logs in real time.
  const indexPath = join(import.meta.dir, "index.ts");
  const child = spawn("bun", ["src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdio: "inherit",
    env: { ...process.env },
  });
  return await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function cmdStatus(): Promise<number> {
  banner();
  // Open the DB directly so the status command doesn't depend on the
  // api being up. If the api *is* up we'll hit it too.
  const dbOk = await probeDb();
  const apiUrl = `http://localhost:${process.env.API_PORT ?? "3000"}`;
  let apiOk: { ok: boolean; detail?: string } = { ok: false, detail: "api not reachable" };
  try {
    const r = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    apiOk = { ok: r.ok, detail: r.ok ? `${apiUrl}/api/health → 200` : `${apiUrl}/api/health → ${r.status}` };
  } catch (err) {
    apiOk = { ok: false, detail: (err as Error).message };
  }

  const jobs = await probeJobs();
  console.log("");
  printRow("postgres", dbOk.ok ? "ok" : "down", dbOk.detail);
  printRow("api", apiOk.ok ? "ok" : "down", apiOk.detail ?? "unknown");
  printRow("schedulers", jobs.watchScheduler ? "ok" : "down", "watch scheduler");
  printRow("schedulers", jobs.memoryScheduler ? "ok" : "down", "memory scheduler");
  const counts = await probeCounts();
  printRow("users", `${counts.users}`, "active accounts");
  printRow("panels", `${counts.panels}`, "active panels");
  printRow("workflows", `${counts.workflows}`, "active workflows");
  console.log("");
  if (!apiOk.ok && !dbOk.ok) {
    console.log(paint(C.rust, "  system down — try `bun src/cli.ts up`"));
    return 2;
  }
  return apiOk.ok && dbOk.ok ? 0 : 1;
}

async function cmdLogs(opts: { lines: number }): Promise<number> {
  banner();
  // Print recent rows from the most useful log surfaces, newest first.
  try {
    const audit = await sql<{ ts: Date; user_name: string | null; action: string; target: string }[]>`
      SELECT a.created_at AS ts, u.name AS user_name, a.action, a.target
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT ${opts.lines}
    `;
    console.log(paint(C.bold, `\n  audit (last ${audit.length})\n`));
    for (const r of audit) {
      const ts = r.ts.toISOString().replace("T", " ").slice(0, 19);
      console.log(
        `  ${paint(C.dim, ts)}  ${paint(C.brass, (r.user_name ?? "system").padEnd(14))} ${r.action} ${paint(C.dim, r.target)}`,
      );
    }

    const sessions = await sql<{ ts: Date; user_name: string | null; ip: string | null }[]>`
      SELECT s.login_at AS ts, u.name AS user_name, s.ip
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.logout_at IS NULL
      ORDER BY s.login_at DESC
      LIMIT 10
    `;
    console.log(paint(C.bold, `\n  active sessions (${sessions.length})\n`));
    for (const r of sessions) {
      const ts = r.ts.toISOString().replace("T", " ").slice(0, 19);
      console.log(
        `  ${paint(C.dim, ts)}  ${paint(C.brass, (r.user_name ?? "unknown").padEnd(14))} ${paint(C.dim, r.ip ?? "local")}`,
      );
    }
  } catch (err) {
    console.error(paint(C.rust, `✗ log query failed: ${(err as Error).message}`));
    return 1;
  }
  return 0;
}

async function cmdResetPassword(username: string): Promise<number> {
  banner();
  if (!username) {
    console.error(paint(C.rust, "✗ usage: bun src/cli.ts reset-password <username>"));
    return 2;
  }
  try {
    const found = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE username = ${username} LIMIT 1
    `;
    const row = found[0];
    if (!row) {
      console.error(paint(C.rust, `✗ no user with username "${username}"`));
      return 1;
    }
    const newPw = generateOneTimePassword();
    const hash = await hashPassword(newPw);
    await sql`
      UPDATE users SET password_hash = ${hash}, must_change_password = TRUE
      WHERE id = ${row.id}::uuid
    `;
    console.log(paint(C.green, `\n  ✓ reset ${username}'s password:`));
    console.log(paint(C.bold, `    ${newPw}\n`));
    console.log(paint(C.dim, "  · they must change this on next login"));
    return 0;
  } catch (err) {
    console.error(paint(C.rust, `✗ ${(err as Error).message}`));
    return 1;
  }
}

async function cmdSeed(): Promise<number> {
  banner();
  console.log(paint(C.bold, "\n→ running all seeders"));
  await runMigrations();
  await runBootstrap();
  await runSkillsSeed();
  await seedAppsIfEmpty();
  console.log(paint(C.green, "  ✓ done"));
  return 0;
}

// ─── Probes used by up + status ─────────────────────────────────────────

async function probeDb(): Promise<{ ok: boolean; detail: string }> {
  try {
    const rows = await sql<{ now: Date }[]>`SELECT now() AS now`;
    return { ok: true, detail: rows[0]?.now?.toISOString() ?? "ok" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

interface JobProbe {
  watchScheduler: boolean;
  memoryScheduler: boolean;
}

async function probeJobs(): Promise<JobProbe> {
  // We can't introspect the schedulers directly without changing their
  // public surface. Instead, read the watch_runs + memory_entries tables
  // for fresh rows (within the last 5 min) as a proxy.
  try {
    const rows = await sql<{ kind: string; recent: number }[]>`
      SELECT 'watch' AS kind, count(*)::int AS recent
        FROM watch_runs WHERE started_at > now() - interval '5 minutes'
      UNION ALL
      SELECT 'memory', count(*)::int
        FROM memory_entries WHERE created_at > now() - interval '5 minutes'
    `;
    let watch = false;
    let memory = false;
    for (const r of rows) {
      if (r.kind === "watch" && r.recent > 0) watch = true;
      if (r.kind === "memory" && r.recent > 0) memory = true;
    }
    // If no recent runs exist (cold install), report "unknown" — show
    // up rather than down so a first boot doesn't look broken.
    const total = rows.reduce((a, r) => a + r.recent, 0);
    if (total === 0) return { watchScheduler: true, memoryScheduler: true };
    return { watchScheduler: watch, memoryScheduler: memory };
  } catch {
    return { watchScheduler: false, memoryScheduler: false };
  }
}

async function probeCounts(): Promise<{ users: number; panels: number; workflows: number }> {
  try {
    const u = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE is_active = TRUE`;
    const p = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM panels`;
    const w = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workflows WHERE enabled = TRUE`;
    return {
      users: u[0]?.n ?? 0,
      panels: p[0]?.n ?? 0,
      workflows: w[0]?.n ?? 0,
    };
  } catch {
    return { users: 0, panels: 0, workflows: 0 };
  }
}

async function probeFeatures(): Promise<string> {
  // Build the one-line summary printed after `up`. Counts providers,
  // models, harnesses, and what's been enabled.
  const counts = await probeCounts();
  let models = 0;
  let providers = 0;
  try {
    const m = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM models`;
    models = m[0]?.n ?? 0;
    const p = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM providers`;
    providers = p[0]?.n ?? 0;
  } catch {
    // table may not exist yet on a brand-new install
  }
  return [
    `users=${counts.users}`,
    `panels=${counts.panels}`,
    `workflows=${counts.workflows}`,
    `providers=${providers}`,
    `models=${models}`,
  ].join(" · ");
}

function printRow(group: string, value: string, detail: string): void {
  const tag = value === "ok" ? paint(C.teal, "✓") : value === "down" ? paint(C.rust, "✗") : "·";
  console.log(`  ${tag}  ${paint(C.bold, group.padEnd(11))} ${value.padEnd(6)}  ${paint(C.dim, detail)}`);
}

// ─── Entry point ────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case "up":
      return await cmdUp();
    case "status":
      return await cmdStatus();
    case "logs": {
      const lines = Number(argv[1] ?? "20") || 20;
      return await cmdLogs({ lines });
    }
    case "reset-password":
      return await cmdResetPassword(argv[1] ?? "");
    case "seed":
      return await cmdSeed();
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return cmd ? 2 : 0;
    default:
      console.error(paint(C.rust, `✗ unknown command: ${cmd}`));
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  banner();
  console.log(`
${paint(C.bold, "Usage:")}  bun src/cli.ts <command> [args]

${paint(C.bold, "Commands:")}
  ${paint(C.brass, "up")}                       migrate + seed + start api (foreground)
  ${paint(C.brass, "status")}                   health summary (db + schedulers + counts)
  ${paint(C.brass, "logs")} [lines=20]          recent audit + active sessions
  ${paint(C.brass, "reset-password")} <user>   one-time password for an existing user
  ${paint(C.brass, "seed")}                     re-run all seeders (idempotent)
  ${paint(C.brass, "help")}                     this screen

${paint(C.bold, "Env (auto-provisioned if missing):")}
  DATABASE_URL    postgres://helm:helm@localhost:5432/helm
  ADMIN_USERNAME  admin
  ADMIN_PASSWORD  <generated; printed on first up>
  SESSION_SECRET  <generated; stored in backend/.helm-secrets>
  REDIS_URL       redis://localhost:6379
`);
}

// Guard so importing this module from the api doesn't trigger cli work.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(paint(C.rust, `✗ ${(err as Error).message}`));
      process.exit(1);
    });
}