// Pi harness — STUB.
//
// Pi is the local agent runtime from @earendil-works/pi-ai. We don't
// ship it yet; this stub makes the seam obvious so a future PR can
// drop in the real wiring without touching the chat route.
//
// To enable:
//   1. bun add @earendil-works/pi-ai
//   2. Replace the chat() body below with a call into the package's
//      session API. The expected surface is roughly:
//        const session = await pi.createSession({ model: req.model });
//        for await (const ev of session.run(req.messages)) {
//          if (ev.type === 'text_delta') yield { delta: ev.text, done: false };
//          if (ev.type === 'usage') {
//            yield { done: true, prompt_tokens: ev.input, completion_tokens: ev.output };
//          }
//        }
//   3. Surface real `listModels()` from the runtime's catalog.

import type { ChatChunk, ChatRequest, Harness } from "./types.ts";

class PiHarness implements Harness {
  readonly kind = "pi" as const;
  readonly label = "pi";

  async status(): Promise<{ configured: boolean; reason?: string }> {
    return {
      configured: false,
      reason:
        "Pi harness not yet wired — install @earendil-works/pi-ai and edit harness/pi.ts to enable",
    };
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    yield {
      delta: "[pi harness not yet wired — install @earendil-works/pi-ai and edit harness/pi.ts to enable]",
      done: true,
      error: "not_wired",
    };
  }
}

export const piHarness: Harness = new PiHarness();
