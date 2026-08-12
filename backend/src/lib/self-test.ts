// Tier 6 — self-test runner.
//
// After an assistant turn finishes, we ask a separate (cheap) model to
// grade the reply. The judge looks at:
//   - did it actually answer the question?
//   - did it stay on topic / not invent facts?
//   - is the formatting coherent?
//   - any obvious safety / refusals issues?
//
// The judge returns a JSON blob of checks; we persist that into
// `self_test_results` so the UI can render a small badge + drill-in
// panel next to the message.
//
// Designed to be fire-and-forget: callers `void runSelfTest(message_id)`
// from the chat handler so chat latency is unaffected. The judge is
// invoked via the same OpenAI harness the chat route uses so we don't
// pull in a second provider just for grading.
//
// Cost guard: skip very short replies (< 40 chars) — nothing meaningful
// to evaluate there. Skip very long ones (> 12k chars) to keep the
// grader's input bounded.

import { sql } from "../db/client.ts";
import { getHarnessByKind } from "../harness/router.ts";
import type { Harness } from "../harness/types.ts";
import { logAudit } from "./audit.ts";

const MIN_CONTENT = 40;
const MAX_CONTENT = 12_000;

export interface SelfTestCheck {
  name: string;
  passed: boolean;
  note?: string;
}

export interface SelfTestResult {
  message_id: string;
  checks: SelfTestCheck[];
  passed: boolean;
  issues: string[];
}

interface MessageForReview {
  id: string;
  role: string;
  content: string;
  model_id: string | null;
  panel_id: string | null;
  created_at: Date;
}

interface ContextRow {
  role: "user" | "assistant" | "system";
  content: string;
}

const JUDGE_SYSTEM_PROMPT = `You are a quality reviewer for an AI assistant's reply.

You will be given:
  - The user's most recent question.
  - The assistant's reply (the one being reviewed).
  - Optional prior context.

Return ONLY a JSON object of this exact shape, no prose outside the JSON:

{
  "passed": true|false,
  "checks": [
    { "name": "<short check name>", "passed": true|false, "note": "<one short sentence>" }
  ],
  "issues": ["<one short sentence per issue>"]
}

Checks to perform (always include these, even if trivial):
  - "addresses_question" — did it actually answer what the user asked?
  - "no_fabrication"    — are the facts plausible / non-hallucinated?
  - "formatting"        — is it readable / not a wall of broken text?
  - "stays_on_topic"    — no weird tangents?
  - "safe"              — no harmful / disallowed content?

Use "passed": true only if EVERY check passes. "issues" should summarise
any specific problems in plain English; empty list when passed=true.

Reply with valid JSON only. No markdown fences. No preamble.`;

/**
 * Run a self-test pass on a message and persist the result. Returns the
 * result if it succeeded; returns null if the message was unsuitable
 * (too short, too long, no parent question) or if the judge itself
 * failed — self-test must never crash the surrounding code path.
 */
export async function runSelfTest(messageId: string): Promise<SelfTestResult | null> {
  try {
    const msgRows = await sql<MessageForReview[]>`
      SELECT id, role, content, model_id, panel_id, created_at
      FROM messages WHERE id = ${messageId}::uuid LIMIT 1
    `;
    const msg = msgRows[0];
    if (!msg) return null;
    if (msg.role !== "assistant") return null;
    const len = msg.content.length;
    if (len < MIN_CONTENT || len > MAX_CONTENT) {
      // Skip — there's nothing useful we can grade here.
      return null;
    }

    // Pull a window of context around the message. Two messages before
    // is usually enough to know what the user was asking.
    const ctx = await sql<ContextRow[]>`
      SELECT role, content FROM messages
      WHERE ((user_id = (SELECT user_id FROM messages WHERE id = ${messageId}::uuid)
               AND panel_id IS NULL)
             OR (panel_id = (SELECT panel_id FROM messages WHERE id = ${messageId}::uuid)))
        AND created_at <= ${msg.created_at.toISOString()}::timestamptz
        AND id <> ${messageId}::uuid
      ORDER BY created_at DESC
      LIMIT 4
    `;
    const userQuestion = ctx
      .filter((r) => r.role === "user")
      .map((r) => r.content.trim())
      .filter((s) => s.length > 0)[0] ?? "(no user question found)";

    const promptBody = JSON.stringify({
      user_question: userQuestion.slice(0, 2000),
      assistant_reply: msg.content.slice(0, 12_000),
      prior_context: ctx.reverse().map((r) => ({ role: r.role, content: r.content.slice(0, 1000) })),
    }, null, 2);

    const harness = getHarnessByKind("openai");
    let assembled = "";
    try {
      for await (const chunk of harness.chat({
        model: await pickJudgeModel(harness),
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: promptBody }],
        temperature: 0.1,
        maxTokens: 700,
      })) {
        if (chunk.done) break;
        if (chunk.delta) assembled += chunk.delta;
      }
    } catch (err) {
      console.warn("[self-test] judge failed:", (err as Error).message);
      return null;
    }
    const parsed = parseJudge(assembled);
    if (!parsed) {
      console.warn("[self-test] could not parse judge output:", assembled.slice(0, 200));
      return null;
    }
    const result: SelfTestResult = {
      message_id: messageId,
      checks: parsed.checks,
      passed: parsed.passed,
      issues: parsed.issues,
    };
    await sql`
      INSERT INTO self_test_results (message_id, checks, passed)
      VALUES (${messageId}::uuid, ${sql.json(result.checks as unknown as Array<Record<string, never>>)}, ${result.passed})
    `;
    await logAudit({
      userId: null,
      target: messageId,
      action: "self_test_completed",
      metadata: {
        passed: result.passed,
        checks: result.checks.length,
        issues: result.issues.length,
      },
    });
    return result;
  } catch (err) {
    // Self-test is best-effort; never crash the chat handler.
    console.warn("[self-test] unhandled error:", (err as Error).message);
    return null;
  }
}

interface ParsedJudge {
  passed: boolean;
  checks: SelfTestCheck[];
  issues: string[];
}

function parseJudge(raw: string): ParsedJudge | null {
  // Strip optional markdown fences the model sometimes adds despite the
  // "no fences" instruction. This is the single most common failure
  // mode and worth being defensive about.
  let s = raw.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) s = fenceMatch[1]!.trim();
  // Locate the JSON object — some judges add leading prose before the {.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    s = s.slice(first, last + 1);
  }
  try {
    const obj = JSON.parse(s);
    if (typeof obj !== "object" || obj === null) return null;
    const passed = typeof obj.passed === "boolean" ? obj.passed : false;
    const checksRaw = Array.isArray(obj.checks) ? obj.checks : [];
    const issuesRaw = Array.isArray(obj.issues) ? obj.issues : [];
    const checks: SelfTestCheck[] = checksRaw
      .filter((c: unknown) => c && typeof c === "object")
      .map((c: Record<string, unknown>) => ({
        name: String(c.name ?? "unknown").slice(0, 60),
        passed: Boolean(c.passed),
        note: typeof c.note === "string" ? c.note.slice(0, 240) : undefined,
      }));
    const issues = issuesRaw
      .filter((i: unknown) => typeof i === "string")
      .map((i: string) => i.slice(0, 240));
    return { passed, checks, issues };
  } catch {
    return null;
  }
}

async function pickJudgeModel(harness: Harness): Promise<string> {
  try {
    const list = await harness.listModels();
    if (list.length > 0) return list[0]!;
  } catch {
    /* fall through */
  }
  return "gpt-4o-mini";
}
