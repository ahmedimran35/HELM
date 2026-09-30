// Swarm Lab — per-round transcript: what each agent said, when it
// finished, and why the debate continued or stopped. Streaming text
// renders live (agent.text); finished rounds show finalText.

import { useEffect, useRef, type FC } from "react";
import type { SwarmState } from "./useSwarmRun";

interface Props {
  state: SwarmState;
}

export const SwarmTimeline: FC<Props> = ({ state }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Autoscroll while the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [state.agents, state.synth, state.consensus.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const rounds = state.roundsCompleted || currentRoundGuess(state);
  const consensusByRound = new Map(state.consensus.map((c) => [c.round, c]));

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="space-y-4 overflow-y-auto pr-1"
      style={{ maxHeight: 420 }}
    >
      {state.search && (
        <section className="rounded-lg border border-border p-3">
          <p className="mono-caps text-[11px] text-textMuted mb-1">
            Shared web search
          </p>
          <p className="text-sm text-textMuted">
            {state.search.count} source{state.search.count === 1 ? "" : "s"}{" "}
            fetched once and handed to every agent.
          </p>
          {state.search.sources.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {state.search.sources.slice(0, 5).map((s) => (
                <li key={s.url} className="text-xs text-textFaint truncate">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-teal underline"
                  >
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {rounds < 1 && (
        <p className="text-sm text-textFaint">
          Waiting for the first round…
        </p>
      )}

      {Array.from({ length: rounds }, (_, i) => i + 1).map((r) => {
        const cons = consensusByRound.get(r);
        const streamRound = state.phase === "round" && state.round === r;
        return (
          <section key={r} className="rounded-lg border border-border p-3 space-y-2">
            <p className="mono-caps text-[11px] text-textMuted">
              Round {r}
              {streamRound && (
                <span className="text-brass"> · answering…</span>
              )}
            </p>
            {state.order.map((id) => {
              const a = state.agents[id];
              if (!a) return null;
              const live = streamRound && a.text.length > 0;
              if (a.status === "error" && !a.finalText && !live) {
                return (
                  <div key={id}>
                    <p className="text-sm text-rust">
                      {a.label} — failed: {a.error}
                    </p>
                  </div>
                );
              }
              return (
                <div key={id}>
                  <p className="mono-caps text-[10px] text-textMuted mb-0.5">
                    {a.label}
                    {a.status === "thinking" && (
                      <span className="text-brass"> · typing</span>
                    )}
                  </p>
                  <p className="text-sm text-text whitespace-pre-wrap">
                    {live ? a.text : a.finalText}
                  </p>
                </div>
              );
            })}
            {cons && (
              <p
                className={`text-xs ${cons.continue_debate ? "text-brass" : "text-teal"}`}
              >
                {cons.continue_debate ? "Debate continues" : "Consensus reached"}
                {cons.reason ? ` — ${cons.reason}` : ""}
              </p>
            )}
          </section>
        );
      })}

      {state.synth && (
        <section className="rounded-lg border border-brass/40 bg-brass/5 p-3">
          <p className="mono-caps text-[11px] text-brass mb-1">Synthesis</p>
          <p className="text-sm text-text whitespace-pre-wrap">{state.synth}</p>
        </section>
      )}
    </div>
  );
};

/** Rounds seen so far when the final event hasn't arrived. */
function currentRoundGuess(state: SwarmState): number {
  return state.round;
}
