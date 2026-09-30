// Swarm Lab orchestrator — the phase machine behind one swarm run.
//
// Phases, in order:
//   SEARCH    one live web search, run once, shared by every call
//   ROUND r   all living agents answer (Promise.all fan-out)
//   SCORE     each agent scores its peers (anonymized answers)
//   CONSENSUS top-scoring agent decides whether another round helps
//             (dynamic — cap MAX_ROUNDS)
//   SYNTH     separate dedicated synthesizer call merges everything
//
// Failure semantics: a single agent failing never kills the run — it is
// excluded via `agent_error` and the swarm continues with the rest. If
// every agent dies in round 1 the run errors out. If the synthesizer
// dies we degrade to the best raw answer rather than fail the run.
//
// Every LLM call (agent, scorer, moderator, synthesizer) is recorded in
// harness_runs with panel_id NULL via recordSwarmModelCall().

import { sql } from "../../db/client.ts";
import { rawConsole } from "../log.ts";
import { runLiveWebSearch, type SearchSummary } from "../chat/context.ts";
import { withFailover } from "../health-check.ts";
import type { ChatRequest, HarnessKind } from "../../harness/types.ts";
import { type SwarmEvent, type SwarmEventEmitter } from "./events.ts";
import {
  agentSystem,
  consensusPrompt,
  renderSearchContext,
  roundBrief,
  scorerPrompt,
  synthesizerPrompt,
  type SearchContextBlock,
} from "./prompts.ts";
import { clampScore, parseLooseJson } from "./parse.ts";

const MAX_ROUNDS = 10;

/** Per-model call timeout — a hung provider must not stall the round. */
const CALL_TIMEOUT_MS = 120_000;

export interface SwarmModel {
  model_id: string;
  external_id: string;
  label: string;
  harness: HarnessKind;
}

export interface SwarmRunInput {
  userId: string;
  question: string;
  models: SwarmModel[];
  searchEnabled: boolean;
  signal: AbortSignal;
}

export interface SwarmRunResult {
  runId: string;
  status: "completed" | "error";
  finalAnswer: string;
  roundsCompleted: number;
  degraded: boolean;
  error?: string;
}

interface RoundRecord {
  round: number;
  answers: Record<string, string>; // model_id -> answer text
  scores: {
    round: number;
    from_model_id: string;
    to_model_id: string;
    score: number;
    critique: string;
  }[];
  consensus: { continue_debate: boolean; reason: string } | null;
}

/** One harness_runs row per LLM call, mirroring chat's persist.ts. */
function recordSwarmModelCall(inputs: {
  userId: string;
  harnessKind: HarnessKind;
  externalId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  errorMessage?: string;
}) {
  void sql`
    INSERT INTO harness_runs (user_id, panel_id, harness, model, prompt_tokens, completion_tokens, latency_ms, status, error)
    VALUES (${inputs.userId}::uuid, NULL, ${inputs.harnessKind}, ${inputs.externalId},
            ${inputs.promptTokens}, ${inputs.completionTokens}, ${inputs.latencyMs},
            ${inputs.errorMessage ? "error" : "ok"}, ${inputs.errorMessage ?? null})
  `.catch((err) =>
    rawConsole.warn("[swarm] harness_runs insert failed:", (err as Error).message),
  );
}

/** Consume one withFailover stream. Returns text + usage; throws on
 *  inline chunk errors or abort. */
async function consumeCall(
  kind: HarnessKind,
  req: ChatRequest,
  onDelta?: (delta: string) => void,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const chunk of withFailover(kind, req, { timeoutMs: CALL_TIMEOUT_MS })) {
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.delta) {
      text += chunk.delta;
      onDelta?.(chunk.delta);
    }
    if (chunk.prompt_tokens != null) promptTokens = chunk.prompt_tokens;
    if (chunk.completion_tokens != null) completionTokens = chunk.completion_tokens;
    if (chunk.done) break;
  }
  if (text.length === 0) throw new Error("empty response");
  return { text, promptTokens, completionTokens };
}

/** Letters for anonymized peer answers in scorer prompts. */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export async function runSwarm(
  input: SwarmRunInput,
  emit: SwarmEventEmitter,
): Promise<SwarmRunResult> {
  const { userId, question, models, searchEnabled, signal } = input;
  const emitEvent: SwarmEventEmitter = (e) => emit(e);

  // ── INSERT run row ───────────────────────────────────────────────────
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO swarm_runs (user_id, question, models)
    VALUES (${userId}::uuid, ${question}, ${sql.json(
      models.map((m) => ({
        model_id: m.model_id,
        external_id: m.external_id,
        label: m.label,
        harness: m.harness,
      })),
    )})
    RETURNING id
  `;
  const runId = inserted[0]!.id;

  const finalize = async (
    status: "completed" | "error",
    extra: { finalAnswer?: string; rounds?: number; error?: string; sources?: { title: string; url: string }[]; transcript?: RoundRecord[] },
  ) => {
    await sql`
      UPDATE swarm_runs SET
        status = ${status},
        final_answer = ${extra.finalAnswer ?? null},
        rounds_completed = ${extra.rounds ?? 0},
        error = ${extra.error ?? null},
        search_sources = ${sql.json(extra.sources ?? [])},
        transcript = ${sql.json((extra.transcript ?? []) as never)},
        completed_at = now()
      WHERE id = ${runId}::uuid
    `.catch((err) =>
      rawConsole.warn("[swarm] run finalize failed:", (err as Error).message),
    );
  };

  emitEvent({
    event: "run_started",
    run_id: runId,
    models: models.map((m) => ({ model_id: m.model_id, label: m.label, harness: m.harness })),
    search_enabled: searchEnabled,
  });

  const abortCheck = () => signal.aborted;

  // ── SEARCH (once, shared) ────────────────────────────────────────────
  emitEvent({ event: "phase", phase: "search" });
  let searchBlock: SearchContextBlock | null = null;
  if (searchEnabled) {
    try {
      const res = await runLiveWebSearch(question, undefined, true, userId);
      // SearchSummary.answer is the synthesized summary text.
      searchBlock = {
        sources: res.sources,
        summary: (res.summary as SearchSummary | null)?.answer ?? null,
      };
    } catch (err) {
      // Search failure is not fatal — agents fall back to their own knowledge.
      rawConsole.warn("[swarm] search failed:", (err as Error).message);
    }
  }
  emitEvent({
    event: "search",
    result_count: searchBlock?.sources.length ?? 0,
    sources: searchBlock?.sources ?? [],
    has_summary: Boolean(searchBlock?.summary),
  });
  const searchCtx = renderSearchContext(searchBlock);

  const transcript: RoundRecord[] = [];
  const alive = new Set(models.map((m) => m.model_id));
  const modelById = new Map(models.map((m) => [m.model_id, m]));
  const peerLabels = new Map(
    models.map((m) => [m.model_id, `${m.label} (${m.external_id})`]),
  );

  // ── ROUND / SCORE / CONSENSUS loop ───────────────────────────────────
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (abortCheck() || alive.size === 0) break;
    emitEvent({ event: "phase", phase: "round", round });

    // Round 1: every living agent answers independently. Round N: the
    // brief carries peers' previous answers + the critiques they got.
    const prior = transcript[transcript.length - 1];
    const turns = models.filter((m) => alive.has(m.model_id));

    const answerResults = await Promise.all(
      turns.map(async (m) => {
        const brief =
          round === 1
            ? roundBrief({ round, question, peers: [], critiques: [] })
            : roundBrief({
                round,
                question,
                peers: Object.entries(prior?.answers ?? {}).map(([id, text]) => ({
                  label: peerLabels.get(id) ?? id,
                  answer: text,
                })),
                critiques:
                  prior?.scores.map((s) => ({
                    from: peerLabels.get(s.from_model_id) ?? s.from_model_id,
                    to: peerLabels.get(s.to_model_id) ?? s.to_model_id,
                    score: s.score,
                    critique: s.critique,
                  })) ?? [],
              });
        const system = agentSystem({
          label: m.label,
          question,
          searchCtx,
          panelSize: models.length,
        });
        const started = Date.now();
        try {
          const r = await consumeCall(
            m.harness,
            {
              model: m.external_id,
              system,
              messages: [{ role: "user", content: brief }],
              signal,
            },
            (delta) =>
              emitEvent({ event: "agent_delta", round, model_id: m.model_id, delta }),
          );
          recordSwarmModelCall({
            userId,
            harnessKind: m.harness,
            externalId: m.external_id,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            latencyMs: Date.now() - started,
          });
          emitEvent({
            event: "agent_done",
            round,
            model_id: m.model_id,
            chars: r.text.length,
            latency_ms: Date.now() - started,
            prompt_tokens: r.promptTokens,
            completion_tokens: r.completionTokens,
          });
          return { id: m.model_id, text: r.text };
        } catch (err) {
          const message = (err as Error).message ?? "unknown error";
          recordSwarmModelCall({
            userId,
            harnessKind: m.harness,
            externalId: m.external_id,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: Date.now() - started,
            errorMessage: message,
          });
          emitEvent({ event: "agent_error", round, model_id: m.model_id, error: message });
          alive.delete(m.model_id);
          return { id: m.model_id, text: null };
        }
      }),
    );

    const answers: Record<string, string> = {};
    for (const r of answerResults) {
      if (r.text != null && r.text.length > 0) answers[r.id] = r.text;
    }
    if (Object.keys(answers).length === 0) {
      // Everyone failed — fatal.
      emitEvent({ event: "error", message: `all agents failed in round ${round}` });
      await finalize("error", { error: "all agents failed", rounds: transcript.length, transcript });
      return { runId, status: "error", finalAnswer: "", roundsCompleted: transcript.length, degraded: false, error: "all agents failed" };
    }

    const record: RoundRecord = { round, answers, scores: [], consensus: null };
    transcript.push(record);

    // A single survivor has nobody to debate — go straight to synthesis.
    if (abortCheck() || alive.size <= 1) break;

    // ── SCORE ──────────────────────────────────────────────────────────
    emitEvent({ event: "phase", phase: "score", round });
    const aliveModels = models.filter((m) => alive.has(m.model_id));
    await Promise.all(
      aliveModels.map(async (m) => {
        const peers = aliveModels
          .filter((p) => p.model_id !== m.model_id)
          .map((p) => ({ key: p.model_id, answer: answers[p.model_id] ?? "" }));
        if (peers.length === 0) return;
        const started = Date.now();
        try {
          const r = await consumeCall(
            m.harness,
            {
              model: m.external_id,
              messages: [
                {
                  role: "user",
                  content: scorerPrompt({ label: m.label, question, peers }),
                },
              ],
              signal,
            },
          );
          recordSwarmModelCall({
            userId,
            harnessKind: m.harness,
            externalId: m.external_id,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            latencyMs: Date.now() - started,
          });
          const parsed = parseLooseJson<{
            scores?: { to?: string; score?: unknown; critique?: string }[];
          }>(r.text, {});
          for (let i = 0; i < peers.length; i++) {
            const match =
              parsed.scores?.find((s) => s.to === LETTERS[i]) ??
              parsed.scores?.[i]; // positional fallback
            if (!match) continue;
            const to = peers[i]!.key;
            const critique = String(match.critique ?? "").slice(0, 500);
            const score = clampScore(match.score);
            if (score <= 0) continue;
            record.scores.push({
              round,
              from_model_id: m.model_id,
              to_model_id: to,
              score,
              critique,
            });
            emitEvent({
              event: "scores",
              round,
              from_model_id: m.model_id,
              scores: [{ to_model_id: to, score, critique }],
            });
          }
        } catch (err) {
          // A scorer failing is non-fatal — the round just loses one ballot.
          rawConsole.warn("[swarm] scorer failed:", (err as Error).message);
          recordSwarmModelCall({
            userId,
            harnessKind: m.harness,
            externalId: m.external_id,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: Date.now() - started,
            errorMessage: (err as Error).message ?? "scorer failed",
          });
        }
      }),
    );

    // ── CONSENSUS (dynamic round control) ──────────────────────────────
    emitEvent({ event: "phase", phase: "consensus", round });
    const avg = new Map<string, number>();
    for (const m of aliveModels) {
      const got = record.scores.filter((s) => s.to_model_id === m.model_id);
      avg.set(
        m.model_id,
        got.length === 0 ? 0 : got.reduce((a, s) => a + s.score, 0) / got.length,
      );
    }
    const moderator =
      [...aliveModels].sort(
        (a, b) =>
          (avg.get(b.model_id) ?? 0) - (avg.get(a.model_id) ?? 0) ||
          a.model_id.localeCompare(b.model_id),
      )[0]!;

    // Cap reached — stop without spending a moderator call.
    if (round >= MAX_ROUNDS) {
      record.consensus = { continue_debate: false, reason: "round cap reached" };
      emitEvent({
        event: "consensus",
        round,
        continue_debate: false,
        reason: "round cap reached",
      });
      break;
    }

    try {
      const stateSummary = aliveModels
        .map((m) => {
          const s = record.scores.filter((x) => x.to_model_id === m.model_id);
          const a = avg.get(m.model_id) ?? 0;
          return `${m.label}: avg ${a.toFixed(1)}/10 from ${s.length} scorer(s), answer length ${answers[m.model_id]?.length ?? 0} chars`;
        })
        .join("\n");
      const started = Date.now();
      const r = await consumeCall(
        moderator.harness,
        {
          model: moderator.external_id,
          messages: [
            {
              role: "user",
              content: consensusPrompt({
                round,
                maxRounds: MAX_ROUNDS,
                question,
                summary: stateSummary,
              }),
            },
          ],
          signal,
        },
      );
      recordSwarmModelCall({
        userId,
        harnessKind: moderator.harness,
        externalId: moderator.external_id,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        latencyMs: Date.now() - started,
      });
      const verdict = parseLooseJson<{ continue?: boolean; reason?: string }>(
        r.text,
        { continue: false, reason: "moderator reply unparseable — stopping" },
      );
      record.consensus = {
        continue_debate: Boolean(verdict.continue),
        reason: String(verdict.reason ?? "").slice(0, 300),
      };
      emitEvent({
        event: "consensus",
        round,
        continue_debate: record.consensus.continue_debate,
        reason: record.consensus.reason,
      });
      if (!record.consensus.continue_debate) break;
    } catch (err) {
      // Moderator failure = stop debating rather than loop forever.
      record.consensus = {
        continue_debate: false,
        reason: "moderator call failed — stopping",
      };
      emitEvent({
        event: "consensus",
        round,
        continue_debate: false,
        reason: record.consensus.reason,
      });
      recordSwarmModelCall({
        userId,
        harnessKind: moderator.harness,
        externalId: moderator.external_id,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        errorMessage: (err as Error).message ?? "moderator failed",
      });
      break;
    }
  }

  // ── ABORT short-circuit: nothing to synthesize over ──────────────────
  if (transcript.length === 0) {
    const message = signal.aborted ? "run aborted" : "no agent produced an answer";
    emitEvent({ event: "error", message });
    await finalize("error", { error: message, transcript });
    return { runId, status: "error", finalAnswer: "", roundsCompleted: 0, degraded: false, error: message };
  }

  // ── SYNTHESIZE (separate dedicated call) ─────────────────────────────
  emitEvent({ event: "phase", phase: "synthesize" });
  const lastRecord = transcript[transcript.length - 1]!;
  const finalAnswers = models
    .filter((m) => lastRecord.answers[m.model_id] != null)
    .map((m) => ({
      label: peerLabels.get(m.model_id) ?? m.label,
      answer: lastRecord.answers[m.model_id]!,
    }));
  const allCritiques = transcript.flatMap((r) =>
    r.scores.map((s) => ({
      from: peerLabels.get(s.from_model_id) ?? s.from_model_id,
      to: peerLabels.get(s.to_model_id) ?? s.to_model_id,
      score: s.score,
      critique: s.critique,
    })),
  );

  const aliveModels = models.filter((m) => alive.has(m.model_id));
  const synthModel = aliveModels[0] ?? models[0]!;

  let finalAnswer = "";
  let degraded = false;
  if (!signal.aborted) {
    try {
      const started = Date.now();
      const r = await consumeCall(
        synthModel.harness,
        {
          model: synthModel.external_id,
          messages: [
            {
              role: "user",
              content: synthesizerPrompt({
                question,
                searchCtx,
                answers: finalAnswers,
                critiques: allCritiques,
              }),
            },
          ],
          signal,
        },
        (delta) => emitEvent({ event: "synth_delta", delta }),
      );
      recordSwarmModelCall({
        userId,
        harnessKind: synthModel.harness,
        externalId: synthModel.external_id,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        latencyMs: Date.now() - started,
      });
      finalAnswer = r.text;
    } catch (err) {
      rawConsole.warn("[swarm] synthesizer failed, degrading:", (err as Error).message);
    }
  }

  if (!finalAnswer) {
    // Degrade to the best raw answer instead of failing the run.
    degraded = true;
    finalAnswer =
      finalAnswers[0]?.answer ??
      "(swarm could not produce a final answer — all calls failed)";
  }

  emitEvent({
    event: "final",
    answer: finalAnswer,
    rounds_completed: transcript.length,
    run_id: runId,
  });
  await finalize(signal.aborted ? "error" : "completed", {
    finalAnswer,
    rounds: transcript.length,
    error: signal.aborted ? "aborted by user" : undefined,
    sources: searchBlock?.sources ?? [],
    transcript,
  });
  return {
    runId,
    status: signal.aborted ? "error" : "completed",
    finalAnswer,
    roundsCompleted: transcript.length,
    degraded,
    error: signal.aborted ? "aborted by user" : undefined,
  };
}
