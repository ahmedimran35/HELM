// Swarm Lab — scoring, made legible. Two views stacked:
//
// 1. LEADERBOARD — agents ranked by peer-score avg, best first, with a
//    score bar per agent and one chip per ballot received (hover =
//    who cast it). Ranks reshuffle live as ballots land.
// 2. BALLOTS — the raw process: each scorer's votes + critiques in
//    their own words, so the "how did this ranking happen" question
//    has a visible answer, not a collapsed afterthought.

import { type FC } from "react";
import type { SwarmState, AgentState } from "./useSwarmRun";

interface Props {
  state: SwarmState;
}

const RANK_STYLES = [
  "border-brass bg-brass/10 text-brass",
  "border-textMuted bg-panelAlt text-text",
  "border-border bg-panelAlt text-textMuted",
];

function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={`mono-caps inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] ${
        RANK_STYLES[rank - 1] ?? "border-border text-textFaint"
      }`}
    >
      {rank}
    </span>
  );
}

function avgFor(state: SwarmState, id: string, rs: SwarmState["scores"]) {
  const got = rs.filter((s) => s.to_model_id === id);
  if (got.length === 0) return null;
  return { avg: got.reduce((acc, s) => acc + s.score, 0) / got.length, ballots: got };
}

function AgentRow({
  a,
  rank,
  entry,
  scoringLive,
  scorerLabel,
}: {
  a: AgentState;
  rank: number | null;
  entry: { avg: number; ballots: SwarmState["scores"] } | null;
  scoringLive: boolean;
  scorerLabel: (id: string) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-6 flex justify-center shrink-0">
        {rank != null ? (
          <RankBadge rank={rank} />
        ) : (
          <span className="h-6 w-6 inline-flex items-center justify-center text-textFaint">
            {scoringLive && a.status !== "error" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-brass animate-pulse" aria-hidden />
            ) : (
              "–"
            )}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm text-text">{a.label}</span>
          {entry != null && (
            <span className="mono-caps text-[11px] text-brass shrink-0">
              {entry.avg.toFixed(1)}/10
            </span>
          )}
          {a.status === "error" && !a.finalText && entry == null && (
            <span className="mono-caps text-[10px] text-rust">failed</span>
          )}
        </div>
        {/* Score bar — width relative to a perfect 10, empty until ballots land */}
        <div className="mt-1 h-1.5 w-full rounded-full bg-panelAlt overflow-hidden">
          <div
            className="h-full rounded-full bg-brass transition-[width] duration-500"
            style={{ width: `${entry ? (entry.avg / 10) * 100 : 0}%` }}
          />
        </div>
        {entry != null && entry.ballots.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.ballots.map((s, i) => (
              <span
                key={i}
                title={`${scorerLabel(s.from_model_id)} scored ${s.score}/10`}
                className="mono-caps text-[9px] text-textMuted border border-border rounded px-1 py-px"
              >
                {scorerLabel(s.from_model_id).slice(0, 6)}·{s.score}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ScoreTable: FC<Props> = ({ state }) => {
  const rounds = state.roundsCompleted || state.round;
  const scoringLive = state.phase === "score";

  if (state.scores.length === 0 && rounds === 0 && !scoringLive) {
    return (
      <p className="text-sm text-textFaint">
        Scores appear after the first debate round — every agent grades its
        peers 1–10, then the leaderboard ranks them by average.
      </p>
    );
  }

  const roundList = Array.from({ length: rounds }, (_, i) => i + 1);

  return (
    <div className="space-y-4">
      {scoringLive && (
        <p className="mono-caps text-[11px] text-brass">
          agents scoring each other…
        </p>
      )}
      {roundList.map((r) => {
        const rs = state.scores.filter((s) => s.round === r);
        const cons = state.consensus.find((c) => c.round === r);

        // Ranked view — sorted by avg, error-without-answer agents sink.
        const ranked = state.order
          .map((id) => ({ id, a: state.agents[id], entry: avgFor(state, id, rs) }))
          .filter((x) => x.a)
          .sort((x, y) => {
            const ax = x.entry?.avg ?? -1;
            const ay = y.entry?.avg ?? -1;
            if (ax !== ay) return ay - ax;
            return x.id.localeCompare(y.id);
          });

        return (
          <section key={r} className="rounded-lg border border-border p-3 space-y-3">
            <p className="mono-caps text-[11px] text-textMuted">
              Round {r} leaderboard
              {rs.length === 0 && (
                <span className="text-textFaint"> · waiting for ballots</span>
              )}
            </p>

            <div className="space-y-2.5">
              {ranked.map(({ id, a, entry }, i) => (
                <AgentRow
                  key={id}
                  a={a!}
                  rank={entry != null ? i + 1 : null}
                  entry={entry}
                  scoringLive={scoringLive}
                  scorerLabel={(sid) => state.agents[sid]?.label ?? sid}
                />
              ))}
            </div>

            {cons && (
              <p
                className={`text-xs ${cons.continue_debate ? "text-brass" : "text-teal"}`}
              >
                {cons.continue_debate ? "Debate continues" : "Consensus reached"}
                {cons.reason ? ` — ${cons.reason}` : ""}
              </p>
            )}

            {rs.some((s) => s.critique) && (
              <div>
                <p className="mono-caps text-[10px] text-textFaint mb-1.5">
                  peer critiques ({rs.filter((s) => s.critique).length})
                </p>
                <ul className="space-y-1.5 border-l border-border pl-3">
                  {rs
                    .filter((s) => s.critique)
                    .map((s, i) => (
                      <li key={i} className="text-xs text-textMuted">
                        <span className="text-text">
                          {state.agents[s.from_model_id]?.label ?? "?"}
                        </span>
                        <span className="text-textFaint"> on </span>
                        <span className="text-text">
                          {state.agents[s.to_model_id]?.label ?? "?"}
                        </span>
                        <span className="mono-caps text-[10px] text-brass ml-1">
                          {s.score}/10
                        </span>
                        <span> — {s.critique}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
