// CLI harness — STUB.
//
// This harness is the escape hatch for "I already have a local agent
// binary and I want HELM to drive it". It's intentionally a stub so
// the seam exists; pointing it at a real binary is a one-file change.
//
// To enable:
//   1. Set HELM_CLI_AGENT_BIN to the path of your agent binary (e.g.
//      /usr/local/bin/opencode). Optionally HELM_CLI_AGENT_ARGS for
//      static flags.
//   2. Replace the chat() body below with a spawn() that pipes the
//      request into stdin and reads NDJSON from stdout, translating
//      `{ "delta": "..." }` lines into ChatChunk yields.

import type { ChatChunk, ChatRequest, Harness } from "./types.ts";

class CliHarness implements Harness {
  readonly kind = "cli" as const;
  readonly label = "cli";

  async status(): Promise<{ configured: boolean; reason?: string }> {
    return {
      configured: false,
      reason:
        "CLI harness not yet wired — point this at your agent binary (set HELM_CLI_AGENT_BIN and edit harness/cli.ts)",
    };
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    yield {
      delta: "[cli harness not yet wired — point this at your agent binary]",
      done: true,
      error: "not_wired",
    };
  }
}

export const cliHarness: Harness = new CliHarness();
