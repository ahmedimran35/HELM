// Unit tests for the Sources-section injection math (chat SSE).
//
// The client contract is: content = content.slice(0, len - replacedLength)
// + delta. These tests pin every branch so a regression in the strip
// regex or the suffix detection fails loudly instead of silently
// duplicating the Sources block (which is what happened before this
// helper existed — the server emitted `replaced_length` that no client
// consumed).

import { describe, test, expect } from "bun:test";
import { planSourcesInjection, formatSources } from "./sources-injection.ts";
import type { SourceRef } from "./sources-injection.ts";

const SOURCES: SourceRef[] = [
  { title: "Alpha", url: "https://example.com/a" },
  { title: "Beta", url: "https://example.com/b" },
];

/** Apply the client-side contract: trim then append. */
function applyClient(content: string, delta: string | null, replacedLength: number): string {
  if (delta === null) return content;
  const trimmed =
    replacedLength > 0
      ? content.slice(0, Math.max(0, content.length - replacedLength))
      : content;
  return trimmed + delta;
}

describe("formatSources", () => {
  test("emits one markdown link bullet per source", () => {
    const lines = formatSources(SOURCES).split("\n");
    expect(lines).toHaveLength(2);
    // Expected markdown bullet built without the literal link sequence
    // so this assertion survives any source-level normalisation.
    const expected = ["- ", "[", "Alpha", "]", "(", SOURCES[0]!.url, ")"].join("");
    expect(lines[0]).toBe(expected);
    expect(lines[1]).toContain(SOURCES[1]!.title);
    expect(lines[1]).toContain(SOURCES[1]!.url);
  });
});

describe("planSourcesInjection", () => {
  test("no sources → no delta, text unchanged", () => {
    const out = planSourcesInjection("hello", []);
    expect(out.delta).toBeNull();
    expect(out.replacedLength).toBe(0);
    expect(out.text).toBe("hello");
  });

  test("body with no Sources section → pure append", () => {
    const raw = "## Answer\n\nSomething useful.";
    const out = planSourcesInjection(raw, SOURCES);
    expect(out.replacedLength).toBe(0);
    expect(out.text).toBe(raw + "\n\n## Sources\n" + formatSources(SOURCES) + "\n");
    // Applying on the client reproduces the server text exactly.
    expect(applyClient(raw, out.delta, out.replacedLength)).toBe(out.text);
  });

  test("model emitted its own trailing Sources section → stripped + replaced", () => {
    const raw = "## Answer\n\nBody text.\n\n## Sources\n- Old\n";
    const out = planSourcesInjection(raw, SOURCES);
    expect(out.replacedLength).toBeGreaterThan(0);
    // Canonical block only appears once.
    expect(out.text.match(/## Sources/g)?.length).toBe(1);
    expect(out.text.startsWith("## Answer")).toBe(true);
    // Client-side application matches the server's final text byte-for-byte.
    expect(applyClient(raw, out.delta, out.replacedLength)).toBe(out.text);
  });

  test("empty body + sources → canonical block only", () => {
    const raw = "## Sources\n- Old\n";
    const out = planSourcesInjection(raw, SOURCES);
    expect(out.text).toBe("## Sources\n" + formatSources(SOURCES) + "\n");
    expect(applyClient(raw, out.delta, out.replacedLength)).toBe(out.text);
  });

  test("mid-document Sources followed by another section → append, no trim", () => {
    const raw = "## Sources\n- Old\n\n## Afterword\nmore text";
    const out = planSourcesInjection(raw, SOURCES);
    // Not a clean suffix, so we must not suffix-trim; we append instead.
    expect(out.replacedLength).toBe(0);
    expect(applyClient(raw, out.delta, out.replacedLength)).toBe(out.text);
  });

  test("case-insensitive heading detection", () => {
    const raw = "Body.\n\n## sources\n- x\n";
    const out = planSourcesInjection(raw, SOURCES);
    expect(out.text.match(/## [Ss]ources/g)?.length).toBe(1);
    expect(applyClient(raw, out.delta, out.replacedLength)).toBe(out.text);
  });
});
