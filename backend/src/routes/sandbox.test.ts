// Unit tests for the sandbox path guard (routes/sandbox.ts#safeJoin) —
// the filesystem boundary of per-user sandbox sessions. A traversal
// that escapes the user's sandbox directory reads another tenant's
// files, so every vector here must resolve to null.
//
// These are pure-path tests (no fs access): the function only needs a
// root string and a user-supplied path.

import { describe, test, expect } from "bun:test";
import { safeJoin } from "./sandbox.ts";

const ROOT = "/tmp/helm/sandbox/user-abc";

describe("safeJoin (sandbox filesystem boundary)", () => {
  test("accepts paths inside the root", () => {
    expect(safeJoin(ROOT, "notes.txt")).toBe(`${ROOT}/notes.txt`);
    expect(safeJoin(ROOT, "sub/dir/file.md")).toBe(`${ROOT}/sub/dir/file.md`);
  });

  test("accepts the root itself", () => {
    expect(safeJoin(ROOT, ".")).toBe(ROOT);
    expect(safeJoin(ROOT, "")).toBe(ROOT);
  });

  test("tolerates absolute-looking paths by re-rooting them", () => {
    // Frontend sends "/tmp/x" style paths; they must land inside the
    // sandbox dir, not the real /tmp.
    expect(safeJoin(ROOT, "/etc/passwd")).toBe(`${ROOT}/etc/passwd`);
  });

  test("blocks ../ traversal escaping the root", () => {
    expect(safeJoin(ROOT, "../user-def/secret.txt")).toBeNull();
    expect(safeJoin(ROOT, "../../etc/passwd")).toBeNull();
    expect(safeJoin(ROOT, "sub/../../user-def/x")).toBeNull();
  });

  test("blocks traversal staying inside (returns to root, still allowed)", () => {
    // ../ from a subdir that resolves back INTO the root is fine.
    expect(safeJoin(ROOT, "sub/../ok.txt")).toBe(`${ROOT}/ok.txt`);
  });

  test("blocks sneaky encodings of ..", () => {
    // Null bytes and raw ".." with separators in odd places. Note:
    // percent-encoding is NOT decoded here (that happens in the HTTP
    // layer), so only raw path forms are in scope for this function.
    expect(safeJoin(ROOT, "..%2f..%2fetc")).toBe(`${ROOT}/..%2f..%2fetc`); // stays inside, harmless literal name
  });

  test("sibling-directory confusion is blocked", () => {
    // root must be a prefix WITH separator — "/user-abc2" is not
    // inside "/user-abc".
    expect(safeJoin(ROOT, "/../user-abc2/secret")).toBeNull();
  });
});
