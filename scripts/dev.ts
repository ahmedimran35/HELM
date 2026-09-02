/**
 * Root dev orchestrator — `bun run dev`
 *
 * Boots the docker-compose dependencies (postgres, redis, lightpanda), waits
 * for the API's DB to accept connections, then runs the backend (watch mode)
 * and the frontend (vite) side by side. Ctrl-C tears everything down.
 *
 * Skips docker entirely with HELM_DEV_NO_DOCKER=1 (dependencies already
 * running / remote DB). Use HELM_DEV_NO_FRONTEND=1 or HELM_DEV_NO_BACKEND=1
 * to run just one side.
 */
import { spawn } from "node:child_process";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", brass: "\x1b[33m", teal: "\x1b[36m", rust: "\x1b[31m" };
const log = (prefix: string, msg: string, color = C.dim) =>
  console.log(`${color}[${prefix}]${C.reset} ${msg}`);

const env = process.env as Record<string, string | undefined>;
const noDocker = env.HELM_DEV_NO_DOCKER === "1";
const noFrontend = env.HELM_DEV_NO_FRONTEND === "1";
const noBackend = env.HELM_DEV_NO_BACKEND === "1";

const procs: { child: ReturnType<typeof spawn>; name: string }[] = [];
let shuttingDown = false;
let startedDocker = false;

function shutdown(code = 0): never {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  log("dev", "shutting down...", C.brass);
  for (const { child, name } of procs) {
    if (child.exitCode === null) {
      log(name, "stopping");
      child.kill("SIGTERM");
    }
  }
  // We started the compose dependencies; bring them back down.
  if (startedDocker && !env.HELM_DEV_KEEP_DOCKER) {
    spawn("docker", ["compose", "down"], { stdio: "ignore" }).on("exit", () => process.exit(code));
  } else {
    setTimeout(() => process.exit(code), 300);
  }
  // Hard exit if something refuses to die.
  setTimeout(() => process.exit(code), 5000).unref?.();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function run(name: string, cmd: string, args: string[], color: string, inherit = true) {
  const child = spawn(cmd, args, {
    cwd: import.meta.dir + "/..",
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    env: { ...env, FORCE_COLOR: "1" },
  });
  procs.push({ child, name });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(name, `exited (code=${code} signal=${signal})`, C.rust);
    shutdown(code ?? 1);
  });
  if (!inherit) {
    child.stdout?.on("data", (d) => process.stdout.write(`${color}[${name}]${C.reset} ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`${color}[${name}]${C.reset} ${d}`));
  }
  return child;
}

async function poll(label: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 750));
  }
  log("dev", `${label} not ready after ${Math.round(timeoutMs / 1000)}s — continuing anyway`, C.rust);
  return false;
}

/** Wait until the backend's Postgres accepts a connection using psql from the container. */
async function waitForDb(): Promise<boolean> {
  try {
    const p = Bun.spawn(
      ["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", "helm", "-d", "helm"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const code = await p.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function main() {
  log("dev", "HELM development orchestrator", C.brass);
  log("dev", `repo root: ${import.meta.dir}/..`);

  if (!noDocker) {
    const hasDocker = await Bun.$`docker info`.quiet().then(
      () => true,
      () => false
    );
    if (hasDocker) {
      log("dev", "starting dependencies (postgres, redis, lightpanda) via docker compose...", C.teal);
      await Bun.$`docker compose up -d postgres redis lightpanda`.quiet().catch((e) => {
        log("dev", `docker compose up failed: ${e.stderr?.toString() ?? e.message}`, C.rust);
        process.exit(1);
      });
      startedDocker = true;
      const ok = await poll("postgres", waitForDb, 60_000);
      if (ok) log("dev", "postgres ready", C.teal);
    } else {
      log(
        "dev",
        "docker not available — assuming postgres/redis are already running (or set HELM_DEV_NO_DOCKER=1 to silence this)",
        C.rust
      );
    }
  } else {
    log("dev", "HELM_DEV_NO_DOCKER=1 — skipping dependency startup", C.dim);
  }

  if (!noBackend) {
    log("dev", "backend  → http://localhost:3000 (bun --watch)", C.brass);
    run("api", "bun", ["run", "--cwd", "backend", "dev"], C.brass);
  }
  if (!noFrontend) {
    log("dev", "frontend → http://localhost:5173 (vite)", C.brass);
    // Run the workspace's own vite via `bun run` so the pinned local version is used,
    // not whatever `bunx` would resolve/download.
    run("web", "bun", ["run", "--cwd", "frontend", "dev"], C.teal);
  }

  log("dev", "Ctrl-C stops everything", C.dim);
}

main().catch((e) => {
  log("dev", `fatal: ${e instanceof Error ? e.message : e}`, C.rust);
  process.exit(1);
});
