import type { MemoryEntry, MemoryScope, MemoryStrategy } from "./types.ts";

export class VectorStrategy implements MemoryStrategy {
  kind = "vector" as const;
  constructor(public readonly config: Record<string, unknown> = {}) {}

  async recall(_query: string, _scope: MemoryScope, _scopeId: string | null, _limit: number): Promise<MemoryEntry[]> {
    // enable by setting HELM_VECTOR_BACKEND and adding embeddings
    return [];
  }

  async ingest(_entry: MemoryEntry, _scope: MemoryScope, _scopeId: string | null): Promise<void> {
    // enable by setting HELM_VECTOR_BACKEND and adding embeddings
  }
}
