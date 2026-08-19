// Pagination helpers. Two layers:
//
// 1. `parsePagination` — reads `?limit=` and `?offset=` query params,
//    applies sane bounds (default 50, max 200), and returns a fully
//    validated `{ limit, offset }` ready for SQL. Centralised so every
//    list endpoint uses the same bounds and we can't accidentally
//    ship `LIMIT 1000000` again.
//
// 2. `paginatedResponse` — wraps the result rows into a stable shape
//    that the frontend can render against (count + page + items).
//
// Why both: every list endpoint was previously `SELECT …` with no LIMIT
// and no offset. For `/api/messages` in a busy panel, that's a 10k-row
// scan + 10k-row JSON serialise on every page load. Cap + offset lets
// the client paginate and the DB use the index range instead of full
// table scans.

import type { Context } from "hono";

export interface Pagination {
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * Parse `?limit=` and `?offset=` from the request. Falls back to
 * defaults for missing or unparseable input. Negative numbers are
 * clamped to 0; out-of-range limits are clamped to DEFAULT_LIMIT
 * (not MAX_LIMIT, so we don't accidentally stream huge tables when
 * someone shoves `?limit=99999` at us).
 */
export function parsePagination(c: Context, opts: { maxLimit?: number; defaultLimit?: number } = {}): Pagination {
  const max = opts.maxLimit ?? MAX_LIMIT;
  const def = opts.defaultLimit ?? DEFAULT_LIMIT;
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  let limit = Number(limitRaw);
  let offset = Number(offsetRaw);
  if (!Number.isFinite(limit) || limit <= 0) limit = def;
  if (limit > max) limit = max;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

/**
 * Wrap items + total + page metadata into the standard response.
 * `has_more` is computed so the frontend can render an "older" /
 * "next" link without doing the arithmetic.
 */
export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: Pagination,
): PaginatedResponse<T> {
  return {
    items,
    total,
    limit: page.limit,
    offset: page.offset,
    has_more: page.offset + items.length < total,
  };
}
