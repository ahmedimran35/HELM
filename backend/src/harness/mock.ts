// Mock harness — used by tests + demo mode. Streams the literal tokens
// "[1][2][3]" and then closes. This gives the frontend a real round-trip
// to render against without spending API credits.

import type { ChatChunk, ChatRequest, Harness } from "./types.ts";

const FIXED_DELTAS = ["[", "1", "]", "[", "2", "]", "[", "3", "]"];

class MockHarness implements Harness {
  readonly kind = "mock" as const;
  readonly label = "mock";

  async status(): Promise<{ configured: boolean }> {
    return { configured: true };
  }

  async listModels(): Promise<string[]> {
    return ["mock-fast", "mock-creative"];
  }

  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    for (const piece of FIXED_DELTAS) {
      // Tiny inter-token delay so the UI shows the typing indicator.
      await new Promise((r) => setTimeout(r, 20));
      yield { delta: piece, done: false };
    }
    yield { done: true, prompt_tokens: 0, completion_tokens: FIXED_DELTAS.length };
  }
}

export const mockHarness: Harness = new MockHarness();
