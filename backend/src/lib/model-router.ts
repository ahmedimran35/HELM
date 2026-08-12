// Cost-aware model router (Tier 5).
//
// The router picks a model for a chat turn based on the user's
// `model_router_policies` row. The policy has two parts:
//
//   - preferences: an ordered list of { model_id, max_cost_cents_per_1k? }
//     entries. The router picks the FIRST entry that satisfies:
//       * the model exists + is active in the `models` table
//       * the user has `model_access` (admins skip this)
//       * the estimated cost for the prompt is under
//         `max_cost_cents_per_1k` (when set)
//
//   - fallback_model_id: a final fallback used when no preference matches
//     or when the panel/user has no row in `model_router_policies` at
//     all. The caller provides `originalModelId` (the model the user
//     chose) and that's used as the default fallback if no policy
//     fallback is configured.
//
// The decision is logged to `response_cache` as a separate row so we
// can later visualise which model the router picked per request. The
// cache key for a router-decision row is sha256("router:" + userId +
// panelId + queryText + ts) — never collides with a real cache hit
// because real cache keys are sha256(queryText) only.

import { createHash } from "node:crypto";
import { sql } from "../db/client.ts";
import { isHarnessKind, type HarnessKind } from "../harness/types.ts";
import { getHarnessHealth } from "./health-check.ts";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface PolicyPreference {
  model_id: string;
  /** Optional cost ceiling in cents per 1k tokens (prompt + completion
   *  combined). When set, this preference is skipped if the prompt's
   *  estimated cost would exceed it. */
  max_cost_cents_per_1k?: number | null;
}

export interface RouterDecision {
  /** The model id the caller should use. */
  modelId: string;
  /** External (provider-side) model id for the harness.chat call. */
  externalId: string;
  /** Which harness kind to send the call to. */
  harnessKind: HarnessKind;
  /** Why this model was picked: 'policy' | 'fallback' | 'original'. */
  reason: "policy" | "fallback" | "original";
  /** Index into the policy's `preferences` list, when reason='policy'. */
  preferenceIndex?: number;
}

interface PolicyRow {
  id: string;
  preferences: PolicyPreference[];
  fallback_model_id: string | null;
}

interface ModelRow {
  id: string;
  external_id: string;
  display_name: string;
  state: string;
  provider_id: string;
  input_price_per_1k: string | null;
  output_price_per_1k: string | null;
}

interface AccessRow {
  model_id: string;
}

/** Estimate the prompt cost in cents. Uses the model's stored
 *  input_price_per_1k (cents per 1k tokens) × estimated prompt tokens.
 *  When the model has no price configured, returns null and the router
 *  treats the cost as "unknown" — meaning the `max_cost_cents_per_1k`
 *  threshold cannot be evaluated for that preference. */
export function estimatePromptCostCents(
  promptChars: number,
  inputPricePer1k: number | null,
): number | null {
  if (inputPricePer1k === null || !Number.isFinite(inputPricePer1k)) return null;
  const estTokens = Math.max(1, Math.ceil(promptChars / 4));
  return (estTokens / 1000) * inputPricePer1k;
}

/** Load the user's router policy. Panel-specific rows take priority
 *  over the user-wide row (the panel_id column is NULL for the
 *  default). Returns null when the user has no policy configured. */
async function loadPolicy(
  userId: string,
  panelId: string | null,
): Promise<PolicyRow | null> {
  // 1. Panel-specific row (panel_id matches).
  if (panelId) {
    const panelRows = await sql<PolicyRow[]>`
      SELECT id, preferences, fallback_model_id
      FROM model_router_policies
      WHERE user_id = ${userId}::uuid AND panel_id = ${panelId}::uuid
      LIMIT 1
    `;
    if (panelRows[0]) return normalisePolicy(panelRows[0]);
  }
  // 2. User-wide row (panel_id IS NULL).
  const userRows = await sql<PolicyRow[]>`
    SELECT id, preferences, fallback_model_id
    FROM model_router_policies
    WHERE user_id = ${userId}::uuid AND panel_id IS NULL
    LIMIT 1
  `;
  if (userRows[0]) return normalisePolicy(userRows[0]);
  return null;
}

function normalisePolicy(row: PolicyRow): PolicyRow {
  // postgres returns jsonb as already-parsed; tag it as our type.
  const prefs = Array.isArray(row.preferences) ? row.preferences : [];
  return { ...row, preferences: prefs };
}

/** Load a model by id. Returns null when missing or not active. */
async function loadModel(modelId: string): Promise<ModelRow | null> {
  const rows = await sql<ModelRow[]>`
    SELECT id, external_id, display_name, state, provider_id,
           input_price_per_1k::text AS input_price_per_1k,
           output_price_per_1k::text AS output_price_per_1k
    FROM models
    WHERE id = ${modelId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Determine the harness kind that serves a given provider. The
 *  chat route uses `harness` from the request body to decide; the
 *  router tries to read it from `providers.type`. Defaults to
 *  'openai' so unknown types still work through the openai-compat
 *  harness (most are). */
async function harnessForProvider(providerId: string): Promise<HarnessKind> {
  const rows = await sql<{ type: string }[]>`
    SELECT type FROM providers WHERE id = ${providerId}::uuid LIMIT 1
  `;
  const t = rows[0]?.type ?? "openai";
  return isHarnessKind(t) ? (t as HarnessKind) : "openai";
}

/** Check the user has access to a model. Admins skip the check. */
async function hasAccess(
  userId: string,
  isAdmin: boolean,
  modelId: string,
): Promise<boolean> {
  if (isAdmin) return true;
  const rows = await sql<AccessRow[]>`
    SELECT model_id FROM model_access
    WHERE user_id = ${userId}::uuid AND model_id = ${modelId}::uuid
    LIMIT 1
  `;
  return rows.length > 0;
}

export interface PickModelInput {
  userId: string;
  isAdmin: boolean;
  /** Requested panel id, or null for global 1:1 chat. */
  panelId: string | null;
  /** The model the user explicitly chose. Used as the original
   *  default when no policy matches. */
  originalModelId: string;
  /** Prompt text — used to estimate cost. */
  prompt: string;
  /** Requested harness (from the chat route's body). The router
   *  keeps it when the chosen model is served by the same harness;
   *  otherwise it switches to the provider's own harness. */
  requestedHarness?: HarnessKind | null;
}

/**
 * Pick a model for the next chat turn. Order of resolution:
 *
 *   1. Walk the user's `model_router_policies.preferences` ordered
 *      list, picking the first preference that:
 *        - resolves to an active model
 *        - the user has access to
 *        - is under the configured cost ceiling (if any)
 *      Skipped preferences are silent — the next one is tried. The
 *      chosen model's harness is whatever serves its provider
 *      (cross-harness routing is allowed).
 *   2. Use `fallback_model_id` (verified active + accessible).
 *   3. Use `originalModelId` (the user's explicit pick).
 *
 * The decision is logged to `response_cache` so the UI can later
 * visualise "this is why we routed to X". Logging is fire-and-forget
 * and never throws.
 */
export async function pickModel(input: PickModelInput): Promise<RouterDecision> {
  const prompt = input.prompt ?? "";

  // Resolve the original model first so we always have a baseline.
  const original = await loadModel(input.originalModelId);
  if (!original) {
    // Original is invalid — caller already validated this. Bail.
    throw new Error("model_not_found");
  }
  const originalDecision: RouterDecision = {
    modelId: original.id,
    externalId: original.external_id,
    harnessKind: input.requestedHarness ?? (await harnessForProvider(original.provider_id)),
    reason: "original",
  };

  const policy = await loadPolicy(input.userId, input.panelId);
  if (!policy) {
    void logRouterDecision(input, originalDecision, "no_policy");
    return originalDecision;
  }

  // Walk the ordered preference list.
  for (let i = 0; i < policy.preferences.length; i++) {
    const pref = policy.preferences[i];
    if (!pref || typeof pref.model_id !== "string") continue;
    const model = await loadModel(pref.model_id);
    if (!model || model.state !== "active") continue;
    if (!(await hasAccess(input.userId, input.isAdmin, model.id))) continue;
    // Cost check (only if a ceiling is set and the price is known).
    if (typeof pref.max_cost_cents_per_1k === "number" && pref.max_cost_cents_per_1k > 0) {
      const inputPrice = model.input_price_per_1k
        ? Number(model.input_price_per_1k)
        : null;
      const estCents = estimatePromptCostCents(prompt.length, inputPrice);
      // When the price is unknown we can't evaluate the ceiling — be
      // conservative and skip. When the cost exceeds the ceiling, skip.
      if (estCents === null || estCents > pref.max_cost_cents_per_1k) continue;
    }
    // Honour harness health — if the model is served by a harness
    // that's currently degraded, skip it. The health cache is in-memory
    // and refreshed every 30s; stale-by-a-few-seconds is fine.
    const kind = await harnessForProvider(model.provider_id);
    const health = getHarnessHealth(kind);
    if (health && health.status === "down") continue;

    const decision: RouterDecision = {
      modelId: model.id,
      externalId: model.external_id,
      harnessKind: kind,
      reason: "policy",
      preferenceIndex: i,
    };
    void logRouterDecision(input, decision, "policy_hit");
    return decision;
  }

  // Nothing in preferences matched — try the explicit fallback.
  if (policy.fallback_model_id) {
    const model = await loadModel(policy.fallback_model_id);
    if (model && model.state === "active") {
      if (await hasAccess(input.userId, input.isAdmin, model.id)) {
        const kind = await harnessForProvider(model.provider_id);
        const decision: RouterDecision = {
          modelId: model.id,
          externalId: model.external_id,
          harnessKind: kind,
          reason: "fallback",
        };
        void logRouterDecision(input, decision, "fallback_hit");
        return decision;
      }
    }
  }

  // Nothing worked — use the user's original pick.
  void logRouterDecision(input, originalDecision, "original_used");
  return originalDecision;
}

/** Fire-and-forget decision logger. Writes one row to response_cache
 *  with a query_hash prefixed so it doesn't collide with real cache
 *  rows. Errors are swallowed — telemetry must never break chat. */
async function logRouterDecision(
  input: PickModelInput,
  decision: RouterDecision,
  outcome: "no_policy" | "policy_hit" | "fallback_hit" | "original_used",
): Promise<void> {
  try {
    const hashInput = `router:${input.userId}:${input.panelId ?? "none"}:${input.prompt.slice(0, 200)}:${Date.now()}`;
    const hash = await sha256Hex(hashInput);
    await sql`
      INSERT INTO response_cache (query_hash, query_text, response_text, model, panel_id, hit_count)
      VALUES (
        ${"router:" + hash},
        ${`router:${outcome}:${decision.modelId}`},
        ${decision.externalId},
        ${decision.harnessKind},
        ${input.panelId},
        0
      )
      ON CONFLICT (query_hash) DO NOTHING
    `;
  } catch {
    /* swallow — telemetry */
  }
}