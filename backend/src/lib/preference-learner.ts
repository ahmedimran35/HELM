// Tier 6 — preference learner.
//
// Reads the user's last 30 days of thumbs feedback, derives a stable
// per-user preference profile (preferred models + disliked patterns), and
// upserts it into `user_preference_profiles`.
//
// The shape of the profile is deliberately simple so it composes with
// the model router policy from Tier 5:
//
//   {
//     preferred_models:   ["<model external_id>", ...]   // sorted by score desc
//     model_scores:       { "<external_id>": 0.87, ... } // raw score
//     dislikes:           ["<pattern>", ...]              // tokens / phrases
//     sample_size:        12                             // votes considered
//     last_computed_at:   "2026-…Z"
//   }
//
// Idempotent. Calling `recomputeProfileForUser(id)` twice in a row
// produces the same row because we always replace rather than
// accumulate — the score is computed from scratch each time.

import { sql } from "../db/client.ts";

export interface UserPreferences {
  preferred_models: string[];
  model_scores: Record<string, number>;
  dislikes: string[];
  sample_size: number;
  last_computed_at: string;
}

const FEEDBACK_WINDOW_DAYS = 30;
// Minimum score for a model to be promoted into preferred_models.
const PROMOTE_THRESHOLD = 0.7;
// Minimum number of up-votes on a single model before it'll ever make
// the cut — guards against a single accidental upvote sinking the whole
// list.
const MIN_UPS_FOR_PROMOTE = 2;

/** Public entry point — recompute a single user. */
export async function recomputeProfileForUser(userId: string): Promise<UserPreferences> {
  // 1. Pull the user's recent feedback with the model external_id
  //    joined in. We need external_id (not the internal UUID) because
  //    that's what downstream systems use to identify models.
  const feedback = await sql<{
    rating: "up" | "down";
    reason: string | null;
    external_id: string;
    model_name: string | null;
  }[]>`
    SELECT f.rating, f.reason, mdl.external_id, mdl.display_name AS model_name
    FROM message_feedback f
    JOIN messages m ON m.id = f.message_id
    JOIN models mdl ON mdl.id = m.model_id
    WHERE f.user_id = ${userId}::uuid
      AND f.created_at >= now() - (${FEEDBACK_WINDOW_DAYS} || ' days')::interval
    ORDER BY f.created_at DESC
  `;

  if (feedback.length === 0) {
    // No signal — return an empty profile. The DB row gets cleared so
    // downstream consumers (model router) can fall back to defaults.
    await saveProfile(userId, {
      preferred_models: [],
      model_scores: {},
      dislikes: [],
      sample_size: 0,
      last_computed_at: new Date().toISOString(),
    });
    return {
      preferred_models: [],
      model_scores: {},
      dislikes: [],
      sample_size: 0,
      last_computed_at: new Date().toISOString(),
    };
  }

  // 2. Per-model score. Wilson-smoothed score isn't worth the
  //    complexity here — the user has small N (often <50 votes total),
  //    and a simple (ups - downs) / total suffices. If a model has zero
  //    votes we skip it (can't derive preference from silence).
  const perModel = new Map<string, { ups: number; downs: number; name: string | null }>();
  for (const row of feedback) {
    if (!row.external_id) continue;
    const cur = perModel.get(row.external_id) ?? { ups: 0, downs: 0, name: row.model_name };
    if (row.rating === "up") cur.ups++;
    else cur.downs++;
    perModel.set(row.external_id, cur);
  }

  const modelScores: Record<string, number> = {};
  for (const [extId, c] of perModel.entries()) {
    const total = c.ups + c.downs;
    if (total === 0) continue;
    modelScores[extId] = (c.ups - c.downs) / total;
  }

  // 3. Sorted preferred_models — those with score >= threshold AND
  //    enough upvotes to be confident.
  const preferredModels = Object.entries(modelScores)
    .filter(([extId, score]) => {
      const c = perModel.get(extId);
      return score >= PROMOTE_THRESHOLD && (c?.ups ?? 0) >= MIN_UPS_FOR_PROMOTE;
    })
    .sort((a, b) => b[1] - a[1])
    .map(([extId]) => extId);

  // 4. Dislikes — tokenise the down-vote `reason` strings, drop
  //    stopwords + anything <3 chars, keep phrases that show up at
  //    least twice across the corpus. Trim to 10 entries so we don't
  //    pollute the prompt with a giant negative list.
  const dislikes = extractDislikes(feedback.map((f) => f.reason).filter((r): r is string => !!r));

  const prefs: UserPreferences = {
    preferred_models: preferredModels,
    model_scores: modelScores,
    dislikes,
    sample_size: feedback.length,
    last_computed_at: new Date().toISOString(),
  };

  await saveProfile(userId, prefs);
  return prefs;
}

async function saveProfile(userId: string, prefs: UserPreferences): Promise<void> {
  // We deliberately do NOT clobber a row whose `manual_overrides` flag
  // is set — the user took the trouble to pin their own preferences, so
  // the learner should respect that. Recompute still updates the
  // underlying *scores* (so we can show "you scored X" in the UI) but
  // keeps preferred_models / dislikes as the user set them.
  const existing = await sql<{ preferences: Record<string, unknown> }[]>`
    SELECT preferences FROM user_preference_profiles
    WHERE user_id = ${userId}::uuid LIMIT 1
  `;
  const wasManual = existing[0]?.preferences?.manual_overrides === true;
  const merged: Record<string, unknown> = {
    ...prefs,
    // Always refresh scores so the UI stays current.
    model_scores: prefs.model_scores,
    sample_size: prefs.sample_size,
    last_computed_at: prefs.last_computed_at,
    manual_overrides: wasManual,
  };
  if (wasManual) {
    merged.preferred_models = existing[0]!.preferences.preferred_models ?? prefs.preferred_models;
    merged.dislikes = existing[0]!.preferences.dislikes ?? prefs.dislikes;
  }
  await sql`
    INSERT INTO user_preference_profiles (user_id, preferences, updated_at)
    VALUES (${userId}::uuid, ${sql.json(merged as Record<string, never>)}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET preferences = EXCLUDED.preferences,
          updated_at  = now()
  `;
}

// ───────────────────────────────────────────────────────────────────
// Stopword list — small + English-focused. The dislikes list is meant
// to inject "don't do this again" hints into the system prompt, so
// generic stopwords would just add noise.
// ───────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "but", "for", "not", "you", "are", "was", "was", "were",
  "this", "that", "with", "have", "has", "had", "from", "into", "they",
  "them", "then", "than", "also", "just", "very", "more", "less", "much",
  "some", "any", "all", "can", "could", "should", "would", "will", "shall",
  "does", "did", "doing", "done", "been", "being", "what", "when", "where",
  "why", "how", "who", "which", "their", "your", "yours", "ours", "mine",
  "his", "her", "its", "our", "out", "off", "over", "under", "again",
  "too", "only", "own", "same", "such", "no", "nor", "yet", "so",
]);

function extractDislikes(reasons: string[]): string[] {
  if (reasons.length === 0) return [];
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    // Lowercase, split on non-word, keep words >= 3 chars.
    const tokens = reason
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  // Sort by frequency, keep phrases that show up >= 2 times. Capping
  // at 10 entries keeps the prompt injection bounded.
  return Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token]) => token);
}

// ───────────────────────────────────────────────────────────────────
// Nightly scheduler — runs once a day, walking users that have any
// feedback in the last 30 days. Idempotent. Wired up by index.ts at
// boot.
// ───────────────────────────────────────────────────────────────────

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

/** Tick cadence is 24h. We also align the first tick to roughly
 *  midnight local time so the run reads as "nightly" in logs. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startPreferenceScheduler(): void {
  if (schedulerHandle) return;
  // Align the first run to the next local midnight (plus a 2-minute
  // offset so we don't collide with the watch + memory schedulers at
  // boot). Subsequent ticks are once every 24h.
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 2, 0, 0);
  const initialDelay = Math.max(60_000, nextMidnight.getTime() - now.getTime());
  schedulerHandle = setTimeout(() => {
    void tick();
    schedulerHandle = setInterval(() => void tick(), ONE_DAY_MS);
  }, initialDelay);
  console.log("✓ preference scheduler armed (next run in",
    Math.round(initialDelay / 60_000), "min)");
}

export function stopPreferenceScheduler(): void {
  if (schedulerHandle) {
    clearTimeout(schedulerHandle);
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

async function tick(): Promise<void> {
  try {
    const targets = await sql<{ user_id: string }[]>`
      SELECT DISTINCT user_id FROM message_feedback
      WHERE created_at >= now() - INTERVAL '30 days'
    `;
    for (const row of targets) {
      await recomputeProfileForUser(row.user_id).catch((err) =>
        console.warn("[preference] recompute failed for", row.user_id, (err as Error).message),
      );
    }
    if (targets.length > 0) {
      console.log("✓ preference learner: recomputed", targets.length, "profiles");
    }
  } catch (err) {
    console.warn("[preference] tick failed:", (err as Error).message);
  }
}
