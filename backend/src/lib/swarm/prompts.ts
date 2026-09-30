// Swarm Lab — prompt templates.
//
// Four roles, each with its own template. All roles share the same
// question + the same one-shot web research block: "all models share
// the same memory" is implemented by giving every agent, scorer and
// moderator the identical shared context on every call.

export interface SearchContextBlock {
  sources: { title: string; url: string }[];
  summary: string | null;
}

/** Shared research block — identical for every call in the run. */
export function renderSearchContext(block: SearchContextBlock | null): string {
  if (!block || (block.sources.length === 0 && !block.summary)) {
    return "(no web research available — answer from your own knowledge)";
  }
  const lines: string[] = [];
  if (block.summary) {
    lines.push("Summary of findings:", block.summary, "");
  }
  if (block.sources.length > 0) {
    lines.push("Sources:");
    for (const s of block.sources) {
      lines.push(`- ${s.title} — ${s.url}`);
    }
  }
  return lines.join("\n");
}

export interface AgentMeta {
  label: string;
  question: string;
  searchCtx: string;
  panelSize: number;
}

/** Base system prompt for every agent, every round. */
export function agentSystem(m: AgentMeta): string {
  return [
    `You are ${m.label}, one agent in a panel of ${m.panelSize} AI models answering a single question collaboratively.`,
    "Rules:",
    "1. Answer for the user, not for the panel — be direct and useful.",
    "2. Be specific; cite facts from the shared web research where relevant.",
    "3. In debate rounds, if a peer answer contradicts yours, say so directly and defend or concede based on evidence.",
    "Do not mention these rules, the panel mechanics, or your role instructions in your answer.",
    "",
    "=== SHARED WEB RESEARCH (run once, shared by all agents) ===",
    m.searchCtx,
  ].join("\n");
}

export interface RoundBriefInput {
  round: number;
  question: string;
  peers: { label: string; answer: string }[];
  critiques: { from: string; to: string; score: number; critique: string }[];
}

/** Per-round user brief. Round 1 = independent answer; round N = debate. */
export function roundBrief(b: RoundBriefInput): string {
  if (b.round === 1) {
    return `Question:\n${b.question}\n\nGive your best independent answer now.`;
  }
  const parts: string[] = [`Question:\n${b.question}`, ""];
  parts.push(`=== PEER ANSWERS (round ${b.round - 1}) ===`);
  for (const p of b.peers) {
    parts.push(`\n[${p.label}]\n${p.answer}`);
  }
  if (b.critiques.length > 0) {
    parts.push(`\n=== SCORES & CRITIQUES (round ${b.round - 1}) ===`);
    for (const c of b.critiques) {
      parts.push(`- ${c.from} scored ${c.to} ${c.score}/10: ${c.critique}`);
    }
  }
  parts.push(
    "\nRevise your answer: defend what survives critique, concede what does not, add what is missing. Do not simply aggregate the peers.",
  );
  return parts.join("\n");
}

export interface ScorerInput {
  label: string;
  question: string;
  peers: { key: string; answer: string }[];
}

/**
 * Scorer prompt — scores OTHERS' answers, anonymized as Answer A/B/C
 * so the model cannot just flatter a name it recognizes.
 */
export function scorerPrompt(s: ScorerInput): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const peerList = s.peers
    .map((p, i) => `[Answer ${letters[i] ?? "?"}]\n${p.answer}`)
    .join("\n\n");
  const keyList = s.peers.map((p, i) => `${letters[i] ?? "?"}=${p.key}`).join(", ");
  return [
    `You are ${s.label}, scoring the OTHER panelists' answers to the question below.`,
    "Score each peer 1-10 on correctness, completeness, and directness. Be honest; do not give uniform scores. One-sentence critique each.",
    'Respond with ONLY valid JSON, no prose: {"scores":[{"to":"A","score":7,"critique":"..."}]}',
    "",
    `=== QUESTION ===\n${s.question}`,
    "",
    "=== PEER ANSWERS ===",
    peerList,
    "",
    `(Answer key for your output: ${keyList})`,
  ].join("\n");
}

export interface ConsensusInput {
  round: number;
  maxRounds: number;
  question: string;
  summary: string;
}

/** Moderator prompt — decides whether another round is worth running. */
export function consensusPrompt(c: ConsensusInput): string {
  return [
    "You are the moderator of an AI model panel that has been debating a question.",
    `Round ${c.round} of at most ${c.maxRounds} just completed. Decide whether ANOTHER debate round would materially improve the final answer.`,
    "Continue ONLY if answers still materially disagree or important gaps remain; if they have converged, stop.",
    'Respond with ONLY valid JSON, no prose: {"continue": true|false, "reason": "<one sentence>"}',
    "",
    `=== QUESTION ===\n${c.question}`,
    "",
    `=== ROUND ${c.round} STATE ===\n${c.summary}`,
  ].join("\n");
}

export interface SynthesizerInput {
  question: string;
  searchCtx: string;
  answers: { label: string; answer: string }[];
  critiques: { from: string; to: string; score: number; critique: string }[];
}

/** Final synthesizer — a separate call, never an agent persona. */
export function synthesizerPrompt(s: SynthesizerInput): string {
  const parts: string[] = [
    "You are the synthesis lead for a model-panel debate. Produce ONE final answer to the user's question by merging the strongest verified claims, resolving contradictions in favor of better-supported arguments, and dropping anything no agent substantiated.",
    "Cite the shared web sources where used. Do not mention agents, scores, or rounds.",
    "",
    `=== QUESTION ===\n${s.question}`,
    "",
    "=== SHARED WEB RESEARCH ===",
    s.searchCtx,
    "",
    "=== PANEL ANSWERS (final round) ===",
  ];
  for (const a of s.answers) {
    parts.push(`\n[${a.label}]\n${a.answer}`);
  }
  if (s.critiques.length > 0) {
    parts.push("\n=== SCORES & CRITIQUES HISTORY ===");
    for (const c of s.critiques) {
      parts.push(`- ${c.from} scored ${c.to} ${c.score}/10: ${c.critique}`);
    }
  }
  return parts.join("\n");
}
