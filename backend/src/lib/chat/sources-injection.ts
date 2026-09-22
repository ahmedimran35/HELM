// Canonical Sources-section injection for streamed chat replies.
//
// Models frequently emit their own "## Sources" block that is
// incomplete, duplicated, or placed mid-document. The server always
// wants a single, complete, canonically-formatted Sources list at the
// very bottom. This module computes the exact SSE delta (and any
// trailing replacement) the client must apply to get from the model's
// raw streamed text to that canonical form.
//
// The client contract is append-only plus an optional suffix trim:
//   content = content.slice(0, len - replacedLength) + delta
// When `replacedLength` is 0 the delta is a pure append.
//
// Kept as a pure function (no SSE, no DB) so the delta math is unit
// tested in sources-injection.test.ts.

export interface SourceRef {
  title: string;
  url: string;
}

export interface SourcesInjection {
  /** The final assembled text after the canonical Sources block. */
  text: string;
  /** Delta to emit to the client, or null when there is nothing to add. */
  delta: string | null;
  /** How many trailing characters the client must drop before appending
   *  `delta`. Non-zero only when the model's own Sources section was a
   *  clean suffix that we stripped. */
  replacedLength: number;
}

// Strips every "## Sources" section (case-insensitive) so we never end
// up with the model's stray section plus our appended one. It does NOT
// consume preceding content.
const STRIP_PATTERN = /\n*##\s+Sources\s*\n[\s\S]*?(?=\n##\s|\n*$)/gim;

/** Build the canonical bullet list for the given sources. Each entry is
 *  a markdown link: dash, space, open-bracket, title, close-bracket,
 *  open-paren, url, close-paren. */
export function formatSources(sources: SourceRef[]): string {
  return sources.map((s) => ["- ", "[", s.title, "]", "(", s.url, ")"].join("")).join("\n");
}

/** Plan the Sources-section injection for one streamed reply. */
export function planSourcesInjection(
  assembled: string,
  sources: SourceRef[],
): SourcesInjection {
  if (sources.length === 0) {
    return { text: assembled, delta: null, replacedLength: 0 };
  }
  const bullets = formatSources(sources);
  const stripped = assembled.replace(STRIP_PATTERN, "").replace(/\s+$/, "");
  const sourcesBlock = (prefix: string) => `${prefix}## Sources\n${bullets}\n`;

  // Fast path: the model's own Sources section (if any) sat at the very
  // end, so the stripped body is a prefix of the raw text. We can
  // express the fix as "drop N trailing chars, then append the block".
  if (stripped.length !== assembled.length && assembled.startsWith(stripped)) {
    const replacedLength = assembled.length - stripped.length;
    const prefix = stripped.length > 0 ? "\n\n" : "";
    const delta = sourcesBlock(prefix);
    return {
      text: stripped + sourcesBlock(prefix),
      delta,
      replacedLength,
    };
  }

  // The model either had no Sources section, or had one in the middle
  // followed by other sections. In both cases we leave the body intact
  // and append a canonical block at the end.
  const addition = sourcesBlock(assembled.length > 0 ? "\n\n" : "");
  return {
    text: assembled + addition,
    delta: addition,
    replacedLength: 0,
  };
}
