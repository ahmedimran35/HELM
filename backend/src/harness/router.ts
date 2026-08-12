// Harness registry. Central place that maps a `HarnessKind` to the
// concrete `Harness` implementation. Adding a new harness is a
// two-step change:
//   1. Add the kind to `HarnessKind` in types.ts and the HARNESS_KINDS list.
//   2. Add the instance to the HARNESSES map below.

import { openaiHarness } from "./openai.ts";
import { anthropicHarness } from "./anthropic.ts";
import { mockHarness } from "./mock.ts";
import { piHarness } from "./pi.ts";
import { cliHarness } from "./cli.ts";
import type { Harness, HarnessKind } from "./types.ts";

const HARNESSES: Record<HarnessKind, Harness> = {
  openai: openaiHarness,
  anthropic: anthropicHarness,
  mock: mockHarness,
  pi: piHarness,
  cli: cliHarness,
};

export function getHarnessByKind(kind: HarnessKind): Harness {
  return HARNESSES[kind];
}

export function listHarnesses(): Harness[] {
  return [
    HARNESSES.openai,
    HARNESSES.anthropic,
    HARNESSES.mock,
    HARNESSES.pi,
    HARNESSES.cli,
  ];
}

export function harnessStatus(kind: HarnessKind): Promise<{
  configured: boolean;
  reason?: string;
}> {
  return HARNESSES[kind].status();
}
