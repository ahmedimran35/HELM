// Swarm Lab — SSE run hook.
//
// Chat.tsx fetch-reader pattern (apiGet/apiPost buffer, so no reuse):
// POST /api/swarm/run, read the body stream, split on `\n\n`, parse
// each `data:` frame as a SwarmEvent, and dispatch into a useReducer.
// AbortController backs the Stop button.

import { useCallback, useEffect, useReducer, useRef } from "react";

export type SwarmPhase =
  | "search"
  | "round"
  | "score"
  | "consensus"
  | "synthesize"
  | "done";

export interface SwarmEvent {
  event: string;
  // run_started
  run_id?: string;
  models?: { model_id: string; label: string; harness: string }[];
  search_enabled?: boolean;
  // phase
  phase?: SwarmPhase;
  round?: number;
  // search
  result_count?: number;
  sources?: { title: string; url: string }[];
  has_summary?: boolean;
  // agent events
  model_id?: string;
  delta?: string;
  chars?: number;
  latency_ms?: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error?: string;
  // scores
  from_model_id?: string;
  scores?: { to_model_id: string; score: number; critique: string }[];
  // consensus
  continue_debate?: boolean;
  reason?: string;
  // final
  answer?: string;
  rounds_completed?: number;
  // fatal error
  message?: string;
}

export interface AgentState {
  model_id: string;
  label: string;
  harness: string;
  status: "idle" | "thinking" | "answered" | "error";
  text: string; // current round's streaming text
  finalText: string; // last completed answer
  avgScore: number | null;
  error?: string;
}

export interface SwarmState {
  status: "idle" | "running" | "done" | "error";
  phase: SwarmPhase | null;
  round: number;
  agents: Record<string, AgentState>; // model_id -> state
  order: string[]; // model_ids in picker order
  scores: {
    round: number;
    from_model_id: string;
    to_model_id: string;
    score: number;
    critique: string;
  }[];
  consensus: { round: number; continue_debate: boolean; reason: string }[];
  search: { count: number; sources: { title: string; url: string }[] } | null;
  synth: string; // streaming final answer
  finalAnswer: string;
  roundsCompleted: number;
  errorMessage: string | null;
}

type Action =
  | { type: "reset"; order: string[]; labels: { model_id: string; label: string; harness: string }[] }
  | { type: "event"; event: SwarmEvent };

function initAgents(
  labels: { model_id: string; label: string; harness: string }[],
): Record<string, AgentState> {
  const agents: Record<string, AgentState> = {};
  for (const m of labels) {
    agents[m.model_id] = {
      model_id: m.model_id,
      label: m.label,
      harness: m.harness,
      status: "idle",
      text: "",
      finalText: "",
      avgScore: null,
    };
  }
  return agents;
}

function reducer(state: SwarmState, action: Action): SwarmState {
  switch (action.type) {
    case "reset": {
      return {
        status: "running",
        phase: null,
        round: 0,
        agents: initAgents(action.labels),
        order: action.order,
        scores: [],
        consensus: [],
        search: null,
        synth: "",
        finalAnswer: "",
        roundsCompleted: 0,
        errorMessage: null,
      };
    }
    case "event": {
      const e = action.event;
      switch (e.event) {
        case "phase":
          return { ...state, phase: e.phase ?? null, round: e.round ?? state.round };
        case "run_started":
          return state; // agents already seeded by reset
        case "search":
          return {
            ...state,
            search: { count: e.result_count ?? 0, sources: e.sources ?? [] },
          };
        case "agent_delta": {
          const a = state.agents[e.model_id ?? ""];
          if (!a) return state;
          return {
            ...state,
            agents: {
              ...state.agents,
              [a.model_id]: {
                ...a,
                status: "thinking",
                text: a.text + (e.delta ?? ""),
              },
            },
          };
        }
        case "agent_done": {
          const a = state.agents[e.model_id ?? ""];
          if (!a) return state;
          return {
            ...state,
            agents: {
              ...state.agents,
              [a.model_id]: {
                ...a,
                status: "answered",
                finalText: a.text,
                text: "",
              },
            },
          };
        }
        case "agent_error": {
          const a = state.agents[e.model_id ?? ""];
          if (!a) return state;
          return {
            ...state,
            agents: {
              ...state.agents,
              [a.model_id]: { ...a, status: "error", error: e.error ?? "failed" },
            },
          };
        }
        case "scores": {
          if (e.event !== "scores") return state;
          const from = e.from_model_id ?? "";
          const incoming = (e.scores ?? []).map((s) => ({
            round: e.round ?? 0,
            from_model_id: from,
            to_model_id: s.to_model_id,
            score: s.score,
            critique: s.critique,
          }));
          const merged = [...state.scores, ...incoming];
          // Recompute averages per recipient.
          const agents = { ...state.agents };
          for (const key of Object.keys(agents)) {
            const got = merged.filter((s) => s.to_model_id === key);
            if (got.length > 0) {
              const cur = agents[key]!;
              agents[key] = {
                ...cur,
                avgScore: got.reduce((acc, s) => acc + s.score, 0) / got.length,
              };
            }
          }
          return { ...state, scores: merged, agents };
        }
        case "consensus":
          return {
            ...state,
            consensus: [
              ...state.consensus,
              {
                round: e.round ?? 0,
                continue_debate: Boolean(e.continue_debate),
                reason: e.reason ?? "",
              },
            ],
          };
        case "synth_delta":
          return { ...state, synth: state.synth + (e.delta ?? "") };
        case "final":
          return {
            ...state,
            status: "done",
            phase: "done",
            finalAnswer: e.answer ?? "",
            roundsCompleted: e.rounds_completed ?? 0,
          };
        case "error":
          return {
            ...state,
            status: "error",
            errorMessage: e.message ?? "swarm run failed",
          };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

const IDLE: SwarmState = {
  status: "idle",
  phase: null,
  round: 0,
  agents: {},
  order: [],
  scores: [],
  consensus: [],
  search: null,
  synth: "",
  finalAnswer: "",
  roundsCompleted: 0,
  errorMessage: null,
};

export interface UseSwarmRunResult {
  state: SwarmState;
  run: (opts: {
    question: string;
    modelIds: string[];
    labels: { model_id: string; label: string; harness: string }[];
    searchEnabled: boolean;
  }) => void;
  stop: () => void;
}

export function useSwarmRun(): UseSwarmRunResult {
  const [state, dispatch] = useReducer(reducer, IDLE);
  const ctrlRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ctrlRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback<UseSwarmRunResult["run"]>((opts) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    dispatch({
      type: "reset",
      order: opts.modelIds,
      labels: opts.labels,
    });

    void (async () => {
      try {
        const res = await fetch("/api/swarm/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            question: opts.question,
            model_ids: opts.modelIds,
            force_web_search: opts.searchEnabled,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null);
          dispatch({
            type: "event",
            event: {
              event: "error",
              message:
                (detail as { error?: string } | null)?.error ??
                `request failed (${res.status})`,
            },
          });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let sawTerminal = false; // final | error seen — stream ended legitimately
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as SwarmEvent;
              if (parsed.event === "final" || parsed.event === "error") {
                sawTerminal = true;
              }
              if (!mountedRef.current) return;
              dispatch({ type: "event", event: parsed });
            } catch {
              // skip malformed frame
            }
          }
        }
        // Stream closed with no terminal event — the server died or the
        // connection dropped mid-run. Surface that, don't fake a final.
        if (!sawTerminal && mountedRef.current) {
          dispatch({
            type: "event",
            event: { event: "error", message: "stream ended before the run completed" },
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          if (mountedRef.current) {
            dispatch({
              type: "event",
              event: { event: "error", message: "aborted" },
            });
          }
          return;
        }
        if (mountedRef.current) {
          dispatch({
            type: "event",
            event: { event: "error", message: (err as Error).message },
          });
        }
      }
    })();
  }, []);

  return { state, run, stop };
}
