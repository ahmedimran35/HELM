// Swarm Lab (experimental) — pick 2–10 governed models, ask one
// question, watch them answer, score each other, debate, and merge
// into one synthesized answer. Everything on this page is driven by
// the useSwarmRun SSE state machine; the canvas is the live
// visualization, the tabs are the readable record.

import { useEffect, useRef, useState, type FC } from "react";
import { PageHeader } from "../components/ui/layout/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Markdown } from "../components/ui/Markdown";
import { apiGet } from "../api/client";
import { useSwarmRun } from "./swarm/useSwarmRun";
import { ModelPicker, type PickedModel } from "./swarm/ModelPicker";
import { SwarmCanvas } from "./swarm/SwarmCanvas";
import { SwarmTimeline } from "./swarm/SwarmTimeline";
import { ScoreTable } from "./swarm/ScoreTable";

type Tab = "graph" | "timeline" | "scores";

interface HistoryRun {
  id: string;
  question: string;
  status: string;
  models: Array<{ model_id: string; external_id?: string; label?: string }> | null;
  rounds_completed: number;
  final_answer: string | null;
  error: string | null;
  created_at: string;
}

const TABS: { value: Tab; label: string }[] = [
  { value: "graph", label: "Graph" },
  { value: "timeline", label: "Timeline" },
  { value: "scores", label: "Scores" },
];

export const SwarmLabPage: FC = () => {
  const { state, run, stop } = useSwarmRun();
  const [question, setQuestion] = useState("");
  const [picked, setPicked] = useState<PickedModel[]>([]);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [tab, setTab] = useState<Tab>("graph");
  const [history, setHistory] = useState<HistoryRun[] | null>(null);
  const [openRun, setOpenRun] = useState<HistoryRun | null>(null);

  // Past runs live in swarm_runs — fetch on mount, refresh when a run
  // finishes so the completed one shows up without a manual reload.
  const loadHistory = () => {
    apiGet<{ runs: HistoryRun[] }>("/swarm/runs")
      .then((r) => setHistory(r.runs ?? []))
      .catch(() => setHistory([]));
  };
  useEffect(loadHistory, []);
  useEffect(() => {
    if (state.status === "done" || state.status === "error") loadHistory();
  }, [state.status]);

  const running = state.status === "running";
  const canRun =
    !running &&
    question.trim().length > 0 &&
    picked.length >= 2 &&
    picked.length <= 10;

  // Elapsed-seconds ticker while a run is live. Slow models can take
  // 60–90 s to first token; without a counter "starting…" reads as stuck.
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (running) {
      if (startedAtRef.current == null) startedAtRef.current = Date.now();
      const t = setInterval(() => setElapsed(Math.floor((Date.now() - (startedAtRef.current ?? 0)) / 1000)), 1000);
      return () => clearInterval(t);
    }
    startedAtRef.current = null;
    setElapsed(0);
  }, [running]);

  const start = () => {
    if (!canRun) return;
    setTab("graph");
    run({
      question: question.trim(),
      modelIds: picked.map((p) => p.model_id),
      labels: picked,
      searchEnabled,
    });
  };

  const phaseLine = () => {
    if (state.status === "error") return state.errorMessage ?? "run failed";
    if (state.phase == null) return running ? "starting…" : "";
    switch (state.phase) {
      case "search":
        return "running shared web search…";
      case "round":
        return `round ${state.round} — agents answering…`;
      case "score":
        return `round ${state.round} — agents scoring each other…`;
      case "consensus":
        return `round ${state.round} — consensus check…`;
      case "synthesize":
        return "synthesizing combined answer…";
      case "done":
        return `done in ${state.roundsCompleted} round${state.roundsCompleted === 1 ? "" : "s"}`;
      default:
        return "";
    }
  };

  return (
    <div className="content-page space-y-6">
      <PageHeader
        title="Agents Swarm"
        subtitle="Pick 2–10 models, ask one question. Every agent shares the same research, answers independently, scores its peers, debates until consensus, then a synthesizer merges the strongest claims into one answer."
        section="EXPERIMENTAL"
        actions={<Badge tone="rust">experimental</Badge>}
      />

      {/* Composer: question + models + run, one surface */}
      <div className="rounded-xl border border-border bg-panel p-4 space-y-4">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask the swarm anything — current events, analysis, comparisons…"
          disabled={running}
          maxLength={8000}
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-panelAlt px-3 py-2.5 text-sm text-text placeholder:text-textFaint focus:outline-none focus:border-brassSoft"
        />

        <ModelPicker selected={picked} onChange={setPicked} disabled={running} />

        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-border">
          {running ? (
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={start} disabled={!canRun}>
              Run swarm
            </Button>
          )}
          <label className="flex items-center gap-2 text-sm text-textMuted cursor-pointer">
            <input
              type="checkbox"
              checked={searchEnabled}
              onChange={(e) => setSearchEnabled(e.target.checked)}
              disabled={running}
              className="accent-teal"
            />
            Shared web search
          </label>

          {/* Phase strip: search → rounds → synthesis, live */}
          <div className="ml-auto flex items-center gap-2 text-xs">
            {running && (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-brass animate-pulse"
                aria-hidden
              />
            )}
            <span
              className={
                running
                  ? "text-brass"
                  : state.status === "error"
                    ? "text-rust"
                    : state.status === "done"
                      ? "text-teal"
                      : "text-textMuted"
              }
            >
              {(running || state.status !== "idle") && phaseLine()}
              {running && elapsed > 0 && (
                <span className="mono-caps text-[10px] text-textFaint ml-2">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Fatal run errors get their own banner — a tiny phase-strip line
          reads as "nothing happened". Maps protocol codes to human text. */}
      {state.status === "error" && state.errorMessage && (
        <div
          role="alert"
          className="rounded-lg border border-rust/40 bg-rust/10 px-4 py-3 text-sm text-rust"
        >
          <span className="mono-caps text-[10px] tracking-wider mr-2">
            run failed
          </span>
          {state.errorMessage === "rate_limited"
            ? "Rate limit: 20 runs per hour. Try again later."
            : state.errorMessage === "aborted"
              ? "Run stopped."
              : state.errorMessage}
        </div>
      )}

      {/* Past runs — proof the lab has history; click opens the run's
          final answer without replaying the transcript */}
      {history != null && history.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {history.slice(0, 8).map((h) => {
            const tone =
              h.status === "completed"
                ? "text-teal"
                : h.status === "error"
                  ? "text-rust"
                  : "text-brass";
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => setOpenRun(openRun?.id === h.id ? null : h)}
                title="Show this run's result"
                className="max-w-full min-w-0 flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-textMuted hover:border-brassSoft hover:text-text transition-colors"
              >
                <span className={`shrink-0 mono-caps text-[10px] tracking-wider ${tone}`}>
                  {h.status}
                </span>
                <span className="truncate max-w-[280px]">{h.question}</span>
                <span className="shrink-0 mono-caps text-[10px] text-textFaint tracking-wider">
                  {h.rounds_completed}r · {shortTime(h.created_at)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded past-run record: final answer / error, no transcript */}
      {openRun && (
        <section className="rounded-xl border border-border bg-panel p-5 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mono-caps text-[10px] text-textFaint tracking-wider mb-1">
                {Array.isArray(openRun.models) ? openRun.models.length : 0} models ·{" "}
                {openRun.rounds_completed} round{openRun.rounds_completed === 1 ? "" : "s"} ·{" "}
                {shortTime(openRun.created_at)}
              </p>
              <p className="text-sm text-text">{openRun.question}</p>
            </div>
            <Button variant="ghost" onClick={() => setOpenRun(null)}>
              Close
            </Button>
          </div>
          {openRun.status === "completed" && openRun.final_answer ? (
            <div className="border-t border-border pt-3">
              <Markdown content={openRun.final_answer} />
            </div>
          ) : openRun.status === "error" ? (
            <p className="text-sm text-rust border-t border-border pt-3">
              {openRun.error ?? "run failed"}
            </p>
          ) : (
            <p className="text-sm text-textMuted border-t border-border pt-3">
              Still running — open the Graph tab once it streams in.
            </p>
          )}
        </section>
      )}

      {/* Canvas + readable record, side tabs */}
      <div className="mt-6 space-y-6">
        <div className="flex items-center gap-1 mb-3 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.value
                  ? "border-brass text-text"
                  : "border-transparent text-textMuted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
          {state.status === "done" && state.roundsCompleted > 0 && (
            <span className="ml-auto mono-caps text-[10px] text-textFaint pb-1">
              {state.roundsCompleted} round{state.roundsCompleted === 1 ? "" : "s"} ·{" "}
              {Object.keys(state.agents).length} agents
            </span>
          )}
        </div>

        {tab === "graph" && <SwarmCanvas state={state} phase={state.phase} />}
        {tab === "timeline" && <SwarmTimeline state={state} />}
        {tab === "scores" && <ScoreTable state={state} />}
      </div>

      {state.status === "done" && state.finalAnswer && (
        <section className="mt-6 rounded-xl border border-brass/40 bg-gradient-to-b from-brass/10 to-transparent p-6">
          <p className="mono-caps text-[11px] text-brass mb-3">
            Combined answer · {state.roundsCompleted} round
            {state.roundsCompleted === 1 ? "" : "s"} ·{" "}
            {Object.keys(state.agents).length} agents
          </p>
          <Markdown content={state.finalAnswer} />
        </section>
      )}
    </div>
  );
};

function shortTime(ts: string): string {
  try {
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${Math.max(diff, 0)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default SwarmLabPage;
