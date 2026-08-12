// Harness API client. Mirrors backend/src/routes/harness.ts:
//
//   GET /api/harnesses              → HarnessInfo[]
//   GET /api/harnesses/:kind/models → { configured, models }
//
// The chat page calls `listHarnesses()` once on mount so it can render
// the active harness as a Badge. The @harness:<kind>/ autocomplete
// will call `getHarnessModels(kind)` later (wired in P2.1).

import { apiGet } from "./client";

export type HarnessKind = "openai" | "anthropic" | "mock" | "pi" | "cli";

export interface HarnessInfo {
  kind: HarnessKind;
  label: string;
  configured: boolean;
  reason?: string;
  model_count: number;
}

export interface HarnessModels {
  kind: HarnessKind;
  configured: boolean;
  reason?: string;
  models: string[];
}

/** Server-side list of harnesses + their per-kind status. */
export async function listHarnesses(): Promise<HarnessInfo[]> {
  return apiGet<HarnessInfo[]>("/harnesses");
}

/** Convenience: list models for one harness. */
export async function getHarnessModels(
  kind: HarnessKind,
): Promise<HarnessModels> {
  return apiGet<HarnessModels>(`/harnesses/${kind}/models`);
}
