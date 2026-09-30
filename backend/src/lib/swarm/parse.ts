// Defensive JSON parsing for LLM-issued structured output.
//
// Scorers, the consensus moderator, and other swarm roles are prompted
// to reply with bare JSON, but models drift — they wrap it in code
// fences, add prose around it, or emit scores outside the scale. Every
// consumer must survive a malformed reply without breaking the round.

/** Clamp a score to the 1–10 panel scale, tolerating 0–100 strings. */
export function clampScore(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return 0;
  if (n > 10 && n <= 100) return Math.round(n / 10); // model used a 0-100 scale
  return Math.max(0, Math.min(10, Math.round(n)));
}

/**
 * Parse a JSON object out of an LLM reply. Strips ``` fences, slices
 * from the first `{` to the last `}`, and falls back to `fallback` on
 * any failure. Never throws.
 */
export function parseLooseJson<T>(text: string, fallback: T): T {
  if (!text) return fallback;
  let s = text.trim();
  // Strip markdown code fences (with or without a language tag).
  s = s.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  try {
    return JSON.parse(s.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}
