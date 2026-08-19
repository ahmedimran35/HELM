// Headless-browser wrapper (Tier 3).
//
// Playwright is *optional*. We import it lazily so the route still
// loads even when Playwright isn't installed — the route handler
// surfaces a clear "browser_unavailable" error to the client.
//
// Actions supported by runBrowser:
//   { type: "goto",   url?: string }       — navigate (overrides outer url)
//   { type: "click",  selector: string }
//   { type: "fill",   selector: string, value: string }
//   { type: "wait",   ms?: number, selector?: string }
//   { type: "extract",selector: string, attr?: string }
//   { type: "screenshot" }                  — take a final screenshot
//
// All "extract" actions are collected; their results return to the
// caller as an `extracted: Record<selector, string[]>` map. The final
// page screenshot is saved to /tmp/browser/<panel_or_user>/<ts>.png
// and the file path is returned to the caller so the API route can
// serve it via the files route.
//
// This file deliberately has no auth — callers (the browser route)
// are responsible for verifying the user.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Cached playwright module + browser. We only ever spin up one
// chromium instance (the user's "agent browser") and reuse it across
// requests. A mutex serialises actions so two requests can't fight
// over the page state.
let cachedModule: typeof import("playwright") | null = null;
let cachedBrowser: import("playwright").Browser | null = null;
let initPromise: Promise<void> | null = null;
const mutex: { current: Promise<unknown> | null } = { current: null };

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutex.current ?? Promise.resolve();
  let resolve: () => void = () => {};
  const next = new Promise<void>((r) => (resolve = r));
  mutex.current = prev.then(() => next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
  }
}

export async function isBrowserAvailable(): Promise<boolean> {
  try {
    await ensureBrowser();
    return true;
  } catch {
    return false;
  }
}

async function ensureBrowser(): Promise<void> {
  if (cachedBrowser && cachedModule) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (cachedBrowser) return;
    try {
      cachedModule = await import("playwright");
    } catch {
      throw new Error("playwright_not_installed");
    }
    cachedBrowser = await cachedModule.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  })();
  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export type BrowserAction =
  | { type: "goto"; url: string }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "wait"; ms?: number; selector?: string }
  | { type: "extract"; selector: string; attr?: string }
  | { type: "screenshot" };

export interface BrowserExecInput {
  url: string;
  actions: BrowserAction[];
  /** Used to scope the screenshot subdir. */
  scope: string;
}

export interface BrowserExecOutput {
  /** Resolved URL after navigation. */
  finalUrl: string;
  /** Final <title> of the page. */
  title: string;
  /** Extracted content keyed by the originating selector. */
  extracted: Record<string, string[]>;
  /** Relative path under the screenshots dir; the route serves this. */
  screenshot: string | null;
  /** Wall-clock duration in ms. */
  duration_ms: number;
  /** Set when Playwright isn't installed; the caller surfaces this. */
  stub?: boolean;
  reason?: string;
}

const SCREENSHOTS_DIR = resolve(process.cwd(), "tmp", "browser");

// Sanity-check the SCREENSHOTS_DIR constant once at module load so a
// misconfigured `process.cwd()` (e.g. /tmp) can't trick containsPath()
// into trusting a wider tree.
if (!SCREENSHOTS_DIR || SCREENSHOTS_DIR === sep) {
  throw new Error("SCREENSHOTS_DIR resolved to filesystem root — refusing to start");
}

/** Strict path-traversal guard. Throws when the resolved path is
 *  outside the allowed root. Rejects:
 *   - `..` segments at any depth
 *   - null bytes
 *   - absolute paths
 *   - symlinks that resolve outside the root (we re-resolve before
 *     returning; this is best-effort under bun without fs.realpath
 *     guarantees — the regex filter is the primary defence) */
function safeJoin(root: string, ...parts: string[]): string {
  for (const p of parts) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("path component must be a non-empty string");
    }
    // Null byte injection (POSIX truncates at NUL).
    if (p.includes("\0")) throw new Error("path component contains null byte");
    // Reject absolute paths and parent-segment navigation.
    if (p.startsWith("/") || p.startsWith("\\")) throw new Error("absolute path rejected");
    if (p === ".." || p === ".") throw new Error("path traversal rejected");
    if (p.split(/[\\/]+/).includes("..")) throw new Error("path traversal rejected");
  }
  const resolved = resolve(root, ...parts);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  // Containment check — the resolved path must be exactly `root` or
  // strictly inside it.
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error("path escapes screenshots root");
  }
  return resolved;
}

/** Lighter-weight check for read paths where the caller already
 *  validated the segments. We still verify containment because the
 *  filename regex can be defeated by unicode lookalikes. */
function containsPath(root: string, candidate: string): boolean {
  const resolved = resolve(candidate);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return resolved === root || resolved.startsWith(rootWithSep);
}

export async function runBrowser(input: BrowserExecInput): Promise<BrowserExecOutput> {
  const start = Date.now();
  // Short-circuit when Playwright isn't installed. The caller can
  // still surface the request with `stub: true` so the UI doesn't
  // hang. We do this *outside* the mutex so a single 503 is fast.
  try {
    await ensureBrowser();
  } catch (err) {
    return {
      finalUrl: input.url,
      title: "",
      extracted: {},
      screenshot: null,
      duration_ms: Date.now() - start,
      stub: true,
      reason: "browser_unavailable",
    };
  }
  return withMutex(async () => {
    const pw = cachedModule!;
    const context = await cachedBrowser!.newContext({
      userAgent:
        "Mozilla/5.0 (HELM-Agent/1.0) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const extracted: Record<string, string[]> = {};
    let finalUrl = input.url;
    let title = "";
    try {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      for (const action of input.actions ?? []) {
        await runAction(page, action, extracted);
      }
      finalUrl = page.url();
      title = await page.title();
      // Always end with a screenshot so the UI has something to show.
      // Path-traversal guard — input.scope is user-controlled (e.g.
      // the panel_id or user_id), so we resolve it against the
      // screenshots root and refuse anything that escapes.
      const scopeDir = safeJoin(SCREENSHOTS_DIR, input.scope);
      await mkdir(scopeDir, { recursive: true });
      const ts = Date.now();
      const screenshotPath = safeJoin(SCREENSHOTS_DIR, input.scope, `${ts}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return {
        finalUrl,
        title,
        extracted,
        screenshot: `${input.scope}/${ts}.png`,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      // Don't leak raw error.message — the browser stub flows up
      // through the API to the model context. Log full details
      // server-side and store a generic marker.
      console.warn("[browser] action failed:", (err as Error).message);
      return {
        finalUrl,
        title,
        extracted,
        screenshot: null,
        duration_ms: Date.now() - start,
        stub: true,
        reason: "browser_action_failed",
      };
    } finally {
      await context.close().catch(() => {});
    }
  });
}

async function runAction(
  page: import("playwright").Page,
  action: BrowserAction,
  extracted: Record<string, string[]>,
): Promise<void> {
  switch (action.type) {
    case "goto":
      await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    case "click":
      await page.click(action.selector, { timeout: 10_000 });
      return;
    case "fill":
      await page.fill(action.selector, action.value, { timeout: 10_000 });
      return;
    case "wait":
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
      } else {
        await page.waitForTimeout(Math.max(0, Math.min(action.ms ?? 250, 10_000)));
      }
      return;
    case "extract": {
      const handle = await page.$$(action.selector);
      const values: string[] = [];
      for (const el of handle) {
        const v = action.attr
          ? await el.getAttribute(action.attr)
          : ((await el.textContent()) ?? "");
        if (v !== null) values.push(v);
      }
      extracted[action.selector] = values;
      return;
    }
    case "screenshot":
      // No-op — the wrapper always takes one at the end. Exposed for
      // future mid-flow snapshots if we want them.
      return;
  }
}

/** Serve a previously saved screenshot. Returns null when the file
 *  doesn't exist (caller returns 404). */
export async function readScreenshot(
  scope: string,
  filename: string,
): Promise<Uint8Array | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return null;
  let path: string;
  try {
    path = safeJoin(SCREENSHOTS_DIR, scope, filename);
  } catch {
    return null;
  }
  // Defence in depth — re-verify containment after the join. A
  // successful safeJoin already guarantees this; the second check
  // future-proofs against a refactor that swaps the helper for plain
  // `join`.
  if (!containsPath(SCREENSHOTS_DIR, path)) return null;
  if (!existsSync(path)) return null;
  // Lazy require to avoid loading node:fs into a non-Node-only env.
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}

/** Save a raw screenshot. Used by tests / future flows that don't go
 *  through the action graph. */
export async function saveScreenshot(
  scope: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  // Path-traversal guard — scope and filename are caller-supplied.
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error("invalid scope");
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) throw new Error("invalid filename");
  const path = safeJoin(SCREENSHOTS_DIR, scope, filename);
  if (!containsPath(SCREENSHOTS_DIR, path)) throw new Error("path traversal rejected");
  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(path, bytes);
  return `${scope}/${filename}`;
}