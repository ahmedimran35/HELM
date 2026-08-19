// Unit tests for the panel-membership helpers.
//
// These tests talk to the real DB — `panel_members` is small and
// isolated. Each test seeds its own panel + member rows so reruns
// are idempotent and don't leak state between runs.
//
// Note on "removed" users: panel_members has no `status` column —
// "removal" is modelled as a DELETE of the row. We exercise that
// path explicitly below.
//
// Note on `requirePanelMember`: the production lib does not export
// such a helper — routes inline the check (`if (!isPanelMember(...))
// return c.json({ error: "forbidden" }, 403)`). We define a
// test-local `requirePanelMember` here that mirrors the same throw
// pattern so we can assert on it directly.

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { sql } from "../db/client.ts";
import { isPanelMember, userPanelIds } from "./panel-membership.ts";

// Mirror of the throw-style guard used by routes that wrap isPanelMember
// in a Hono middleware. Keeping this local (not in production code)
// avoids touching the public surface of panel-membership.ts.
async function requirePanelMember(
  userId: string,
  panelId: string,
  isAdmin = false,
): Promise<void> {
  const ok = await isPanelMember(userId, panelId, isAdmin);
  if (!ok) {
    throw new Error("forbidden: not a panel member");
  }
}

async function makeUser(name: string): Promise<string> {
  const r = await sql<{ id: string }[]>`
    INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
    VALUES (${name}, ${name}, 'fake-hash', 'user', false, true)
    RETURNING id
  `;
  return r[0]!.id;
}

async function makePanel(createdBy: string): Promise<string> {
  const r = await sql<{ id: string }[]>`
    INSERT INTO panels (name, created_by)
    VALUES ('probe-' || ${createdBy}, ${createdBy}::uuid)
    RETURNING id
  `;
  return r[0]!.id;
}

async function cleanupFixtures(): Promise<void> {
  // Wipe only the rows we created — names start with `probe-` and
  // usernames match `__probe_*`.
  await sql`DELETE FROM panel_members WHERE panel_id IN (SELECT id FROM panels WHERE name LIKE 'probe-%')`;
  await sql`DELETE FROM panels WHERE name LIKE 'probe-%'`;
  await sql`DELETE FROM users WHERE username LIKE 'probe-%'`;
}

beforeEach(async () => {
  await cleanupFixtures();
});
afterAll(async () => {
  await cleanupFixtures();
  // Don't call sql.end() — the pool is shared across all test files
  // via globalThis.__helm_sql__. Process exit handles teardown.
});

describe("isPanelMember", () => {
  test("returns true for a member", async () => {
    const owner = await makeUser("probe-owner-" + Date.now());
    const member = await makeUser("probe-member-" + Date.now());
    const panel = await makePanel(owner);
    await sql`
      INSERT INTO panel_members (panel_id, user_id)
      VALUES (${panel}::uuid, ${member}::uuid)
    `;
    expect(await isPanelMember(member, panel)).toBe(true);
  });

  test("returns false for a non-member", async () => {
    const owner = await makeUser("probe-owner2-" + Date.now());
    const stranger = await makeUser("probe-stranger-" + Date.now());
    const panel = await makePanel(owner);
    expect(await isPanelMember(stranger, panel)).toBe(false);
  });

  test("returns false for a removed user (row deleted)", async () => {
    // "Removed" in this codebase is modelled as a DELETE from
    // panel_members, not a soft-delete column. Confirm membership
    // goes from true -> false across the delete.
    const owner = await makeUser("probe-owner3-" + Date.now());
    const member = await makeUser("probe-exmember-" + Date.now());
    const panel = await makePanel(owner);
    await sql`
      INSERT INTO panel_members (panel_id, user_id)
      VALUES (${panel}::uuid, ${member}::uuid)
    `;
    expect(await isPanelMember(member, panel)).toBe(true);
    await sql`
      DELETE FROM panel_members WHERE panel_id = ${panel}::uuid AND user_id = ${member}::uuid
    `;
    expect(await isPanelMember(member, panel)).toBe(false);
  });

  test("returns true for any user when isAdmin=true (admin bypass)", async () => {
    const owner = await makeUser("probe-owner4-" + Date.now());
    const admin = await makeUser("probe-admin-" + Date.now());
    const panel = await makePanel(owner);
    // admin is not in panel_members, but isAdmin=true short-circuits.
    expect(await isPanelMember(admin, panel, true)).toBe(true);
    // ... and isAdmin=false (default) still returns false.
    expect(await isPanelMember(admin, panel, false)).toBe(false);
  });
});

describe("requirePanelMember", () => {
  test("throws on non-member", async () => {
    const owner = await makeUser("probe-owner5-" + Date.now());
    const stranger = await makeUser("probe-stranger2-" + Date.now());
    const panel = await makePanel(owner);
    expect(requirePanelMember(stranger, panel)).rejects.toThrow(/forbidden/);
  });

  test("returns (resolves) on a member", async () => {
    const owner = await makeUser("probe-owner6-" + Date.now());
    const member = await makeUser("probe-member2-" + Date.now());
    const panel = await makePanel(owner);
    await sql`
      INSERT INTO panel_members (panel_id, user_id)
      VALUES (${panel}::uuid, ${member}::uuid)
    `;
    // Bun's expect resolves promises — a successful await returns
    // undefined, and the assertion is just "didn't throw".
    await expect(requirePanelMember(member, panel)).resolves.toBeUndefined();
  });
});

describe("userPanelIds", () => {
  test("returns the panels a user is a member of", async () => {
    const owner = await makeUser("probe-owner7-" + Date.now());
    const member = await makeUser("probe-member3-" + Date.now());
    const p1 = await makePanel(owner);
    const p2 = await makePanel(owner);
    await sql`
      INSERT INTO panel_members (panel_id, user_id)
      VALUES (${p1}::uuid, ${member}::uuid),
             (${p2}::uuid, ${member}::uuid)
    `;
    const ids = await userPanelIds(member);
    expect(ids.sort()).toEqual([p1, p2].sort());
  });

  test("returns every panel when isAdmin=true", async () => {
    // admin path returns EVERY row in `panels`, so we can't compare
    // exact sets (other fixtures may exist). Instead verify our two
    // freshly-created panels are present.
    const owner = await makeUser("probe-owner8-" + Date.now());
    const p1 = await makePanel(owner);
    const p2 = await makePanel(owner);
    const admin = await makeUser("probe-admin2-" + Date.now());
    const ids = await userPanelIds(admin, true);
    expect(ids).toContain(p1);
    expect(ids).toContain(p2);
  });
});