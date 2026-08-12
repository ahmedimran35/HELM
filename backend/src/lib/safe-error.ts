// Sanitize error responses.
//
// Many routes return `c.json({ error: (err as Error).message }, 4xx)`
// which leaks internal details (SQL constraint names, file paths, stack
// frames from libraries). The fix is to log the full error server-side
// and return a generic, non-revealing message to the client.
//
// `safeError` wraps an error-handler body so the route can `return
// safeError(c, err, { status: 400, code: "bad_request" })` and get a
// safe response without manual sanitisation.
import type { Context } from "hono";

interface SafeErrorOptions {
  status?: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;
  /** Stable, non-revealing error code (e.g. "bad_request", "not_found"). */
  code: string;
  /** Public message; defaults to code. Keep it short and non-leaky. */
  publicMessage?: string;
  /** Log the full err.message server-side. Defaults to true. */
  log?: boolean;
}

export function safeError(c: Context, err: unknown, opts: SafeErrorOptions) {
  if (opts.log !== false) {
    // Log full error server-side; never echo to client.
    console.warn(`[${opts.code}] ${(err as Error)?.message ?? err}`);
  }
  return c.json(
    { error: opts.publicMessage ?? opts.code },
    opts.status ?? 500,
  );
}
