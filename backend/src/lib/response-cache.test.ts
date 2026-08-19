// Unit tests for the semantic response cache (Tier 5).
//
// These tests talk to the real DB — the production code uses a postgres
// connection and the schema is small + isolated. We seed + tear down
// rows per-test so multiple runs are hermetic (idempotent reruns).

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { sql } from "../db/client.ts";
import {
  hashQuery,
  lookupCached,
  storeCached,
  normaliseQuery,
} from "./response-cache.ts";

// Two synthetic user ids for scope-isolation tests. We don't need a
// row in `users` for hash isolation, only for the FK-less hash path.
const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const PANEL_X = "00000000-0000-0000-0000-0000000000a1";
const PANEL_Y = "00000000-0000-0000-0000-0000000000a2";

beforeEach(async () => {
  // Wipe only the response_cache rows we own by test — we don't want to
  // interfere with rows other tests inserted.
  await sql`DELETE FROM response_cache WHERE model = 'test-model'`;
});

afterAll(async () => {
  await sql`DELETE FROM response_cache WHERE model = 'test-model'`;
  // Don't call sql.end() — the pool is shared across all test files
  // via globalThis.__helm_sql__. Process exit handles teardown.
});

describe("hashQuery", () => {
  test("is deterministic for the same scope + query", () => {
    const h1 = hashQuery("hi", PANEL_X, USER_A);
    const h2 = hashQuery("hi", PANEL_X, USER_A);
    expect(h1).toBe(h2);
  });

  test("differs across users (cross-user leak defence)", () => {
    const a = hashQuery("hi", null, USER_A);
    const b = hashQuery("hi", null, USER_B);
    expect(a).not.toBe(b);
  });

  test("differs across panels (cross-panel leak defence)", () => {
    const a = hashQuery("hi", PANEL_X, USER_A);
    const b = hashQuery("hi", PANEL_Y, USER_A);
    expect(a).not.toBe(b);
  });

  test("normalises trivial whitespace + case differences", () => {
    const a = hashQuery("Hello World", PANEL_X, USER_A);
    const b = hashQuery("  hello   world  ", PANEL_X, USER_A);
    expect(a).toBe(b);
    // Verify the normaliser is doing what we expect — sanity check that
    // our expectations about the hash aren't blind.
    expect(normaliseQuery("  Hello   WORLD  ")).toBe("hello world");
  });

  test("differs between panel scope and user scope for the same text", () => {
    const panelHash = hashQuery("hi", PANEL_X, USER_A);
    const userHash = hashQuery("hi", null, USER_A);
    expect(panelHash).not.toBe(userHash);
  });
});

describe("lookupCached", () => {
  test("returns null on a miss (no row, no error)", async () => {
    const r = await lookupCached(
      "definitely-not-cached-" + Date.now(),
      null,
      { userId: USER_A },
    );
    expect(r).toBeNull();
  });

  test("returns the row on a hit", async () => {
    // Use panel_id=null so we don't have to spin up a real `panels`
    // row (response_cache.panel_id has an FK to panels).
    const q = "cache-hit-" + Date.now();
    await storeCached(q, "the-response", "test-model", null, { userId: USER_A });
    const r = await lookupCached(q, null, { userId: USER_A });
    expect(r).not.toBeNull();
    expect(r?.query_text).toBe(q);
    expect(r?.response_text).toBe("the-response");
    expect(r?.model).toBe("test-model");
  });

  test("returns null on an expired row (expires_at < now())", async () => {
    // Insert directly with expires_at in the past. This bypasses the
    // TTL logic in storeCached so we can deterministically exercise
    // the expiry path without waiting. panel_id=null to avoid FK.
    const q = "expired-" + Date.now();
    const hash = hashQuery(q, null, USER_A);
    await sql`
      INSERT INTO response_cache
        (query_hash, query_text, response_text, model, panel_id, hit_count, expires_at)
      VALUES
        (${hash}, ${q}, 'old-response', 'test-model', NULL, 0, now() - interval '1 second')
    `;
    const r = await lookupCached(q, null, { userId: USER_A });
    expect(r).toBeNull();
  });
});

describe("storeCached", () => {
  test("writes a row with the correct expires_at (TTL respected)", async () => {
    // Force a non-default TTL by setting the env var for this test.
    const prev = process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
    process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = "120";
    try {
      const q = "ttl-check-" + Date.now();
      await storeCached(q, "x", "test-model", null, { userId: USER_A });
      const rows = await sql<{ ttl_seconds: number }[]>`
        SELECT EXTRACT(EPOCH FROM (expires_at - now()))::int AS ttl_seconds
        FROM response_cache WHERE query_text = ${q}
      `;
      const ttl = rows[0]?.ttl_seconds ?? -1;
      // Allow a few seconds of skew between now() and the server clock.
      expect(ttl).toBeGreaterThan(110);
      expect(ttl).toBeLessThan(130);
    } finally {
      if (prev === undefined) delete process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
      else process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = prev;
    }
  });

  test("is idempotent under ON CONFLICT (same hash, new response updates expires_at)", async () => {
    const prev = process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
    process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = "60";
    try {
      const q = "idempotent-" + Date.now();
      const hash = hashQuery(q, null, USER_A);

      // First write — captures row id.
      await storeCached(q, "first", "test-model", null, { userId: USER_A });
      const first = await sql<{ id: string; response_text: string }[]>`
        SELECT id, response_text FROM response_cache WHERE query_hash = ${hash}
      `;
      expect(first.length).toBe(1);
      expect(first[0]!.response_text).toBe("first");
      const id = first[0]!.id;

      // Force the second write to have a later expires_at by waiting a
      // tick (now() advances). Then store again with a new response.
      await new Promise((r) => setTimeout(r, 1100));
      await storeCached(q, "second", "test-model", null, { userId: USER_A });

      const second = await sql<{ id: string; response_text: string; expires_at: Date }[]>`
        SELECT id, response_text, expires_at FROM response_cache WHERE query_hash = ${hash}
      `;
      // Same row (same id) — not a duplicate.
      expect(second.length).toBe(1);
      expect(second[0]!.id).toBe(id);
      // The ON CONFLICT clause in storeCached only refreshes expires_at,
      // NOT response_text — that's intentional (concurrent writes don't
      // clobber each other's content). Verify both behaviors:
      expect(second[0]!.response_text).toBe("first");
      const ttl = await sql<{ ttl_seconds: number }[]>`
        SELECT EXTRACT(EPOCH FROM (expires_at - now()))::int AS ttl_seconds
        FROM response_cache WHERE query_hash = ${hash}
      `;
      const remaining = ttl[0]?.ttl_seconds ?? -1;
      // The TTL was refreshed by the second store (now ~60s again).
      expect(remaining).toBeGreaterThan(55);
    } finally {
      if (prev === undefined) delete process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
      else process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = prev;
    }
  });

  test("TTL=0 disables writes (env-controlled kill switch)", async () => {
    const prev = process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
    process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = "0";
    try {
      const q = "ttl-zero-" + Date.now();
      await storeCached(q, "x", "test-model", null, { userId: USER_A });
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM response_cache WHERE query_text = ${q}
      `;
      expect(rows[0]?.count ?? 0).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
      else process.env.HELM_RESPONSE_CACHE_TTL_SECONDS = prev;
    }
  });
});