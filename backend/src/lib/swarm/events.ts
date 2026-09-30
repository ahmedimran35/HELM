// Swarm Lab — SSE event protocol.
//
// The swarm route streams one event per JSON object below. This event
// set is deliberately separate from the chat SSE helpers in
// lib/chat/stream.ts — that file's lock-step comment exists so the chat
// UI and its routes stay in sync; swarm events have a different
// consumer (SwarmLab page) and must not pollute the chat contract.

export type SwarmPhase =
  | "search"
  | "round"
  | "score"
  | "consensus"
  | "synthesize"
  | "done";

export interface SwarmRunStarted {
  run_id: string;
  models: { model_id: string; label: string; harness: string }[];
  search_enabled: boolean;
}

export interface SwarmPhaseEvent {
  phase: SwarmPhase;
  round?: number;
}

export interface SwarmSearchEvent {
  result_count: number;
  sources: { title: string; url: string }[];
  has_summary: boolean;
}

export interface SwarmAgentDelta {
  round: number;
  model_id: string;
  delta: string;
}

export interface SwarmAgentDone {
  round: number;
  model_id: string;
  chars: number;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface SwarmAgentError {
  round: number;
  model_id: string;
  error: string;
}

export interface SwarmScores {
  round: number;
  from_model_id: string;
  scores: { to_model_id: string; score: number; critique: string }[];
}

export interface SwarmConsensus {
  round: number;
  continue_debate: boolean;
  reason: string;
}

export interface SwarmSynthDelta {
  delta: string;
}

export interface SwarmFinal {
  answer: string;
  rounds_completed: number;
  run_id: string;
}

export type SwarmEvent =
  | ({ event: "run_started" } & SwarmRunStarted)
  | ({ event: "phase" } & SwarmPhaseEvent)
  | ({ event: "search" } & SwarmSearchEvent)
  | ({ event: "agent_delta" } & SwarmAgentDelta)
  | ({ event: "agent_done" } & SwarmAgentDone)
  | ({ event: "agent_error" } & SwarmAgentError)
  | ({ event: "scores" } & SwarmScores)
  | ({ event: "consensus" } & SwarmConsensus)
  | ({ event: "synth_delta" } & SwarmSynthDelta)
  | ({ event: "final" } & SwarmFinal)
  | ({ event: "error" } & { message: string });

export type SwarmEventEmitter = (e: SwarmEvent) => void;
