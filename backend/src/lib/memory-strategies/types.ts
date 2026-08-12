export type MemoryScope = "personal" | "team" | "admin";
export type MemoryStrategyKind = "rows" | "summary" | "vector";

export interface MemoryEntry {
  id: string;
  user_id: string | null;
  user_name?: string | null;
  text: string;
  source_type: string;
  source_id: string | null;
  scope: MemoryScope;
  created_at: Date;
  metadata?: Record<string, unknown>;
}

export interface MemoryStrategy {
  kind: MemoryStrategyKind;
  id?: string;
  scope?: MemoryScope;
  scopeId?: string | null;
  priority?: number;
  config?: Record<string, unknown>;
  recall(query: string, scope: MemoryScope, scopeId: string | null, limit: number): Promise<MemoryEntry[]>;
  ingest(entry: MemoryEntry, scope: MemoryScope, scopeId: string | null): Promise<void>;
  summarize?(entries: MemoryEntry[]): Promise<string>;
}
