import { sql } from "../../db/client.ts";
import { RowsStrategy } from "./rows.ts";
import { SummaryStrategy } from "./summary.ts";
import { VectorStrategy } from "./vector.ts";
import type { MemoryEntry, MemoryScope, MemoryStrategy, MemoryStrategyKind } from "./types.ts";

interface SummaryStrategyLike {
  summarizePending?: (scope: MemoryScope, scopeId: string | null) => Promise<number>;
}

interface StrategyRow {
  id: string;
  scope: MemoryScope;
  scope_id: string | null;
  kind: MemoryStrategyKind;
  config: Record<string, unknown>;
  priority: number;
}

function makeStrategy(row: StrategyRow): MemoryStrategy {
  const config = row.config ?? {};
  const strategy: MemoryStrategy = row.kind === "rows" ? new RowsStrategy(config)
    : row.kind === "summary" ? new SummaryStrategy(config) : new VectorStrategy(config);
  strategy.id = row.id;
  strategy.scope = row.scope;
  strategy.scopeId = row.scope_id;
  strategy.priority = row.priority;
  return strategy;
}

export async function getStrategies(scope: MemoryScope, scopeId: string | null): Promise<MemoryStrategy[]> {
  const rows = await sql<StrategyRow[]>`
    SELECT id, scope, scope_id, kind, config, priority
    FROM memory_strategies
    WHERE enabled AND scope = ${scope}
      AND (scope_id IS NULL OR scope_id = ${scopeId}::uuid)
    ORDER BY priority ASC, created_at ASC
  `;
  // Preserve the pre-P6 behavior for installations without configuration.
  return rows.length ? rows.map(makeStrategy) : [new RowsStrategy()];
}

export async function recall(query: string, scope: MemoryScope, scopeId: string | null, limit: number): Promise<MemoryEntry[]> {
  const strategies = await getStrategies(scope, scopeId);
  const batches = await Promise.all(strategies.map((strategy) => strategy.recall(query, scope, scopeId, limit)));
  const seen = new Set<string>();
  return batches.flat().filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit);
}

export async function ingest(entry: MemoryEntry, scope: MemoryScope, scopeId: string | null): Promise<void> {
  const strategies = await getStrategies(scope, scopeId);
  await Promise.all(strategies.map((strategy) => strategy.ingest(entry, scope, scopeId)));
}

export async function summarizeStrategy(id: string): Promise<number> {
  const rows = await sql<StrategyRow[]>`SELECT id, scope, scope_id, kind, config, priority FROM memory_strategies WHERE id = ${id}::uuid AND enabled`;
  const strategy = rows[0] ? makeStrategy(rows[0]) : null;
  const summarizer = strategy as SummaryStrategyLike;
  if (!strategy || strategy.kind !== "summary" || !summarizer.summarizePending) return 0;
  return summarizer.summarizePending(strategy.scope!, strategy.scopeId ?? null);
}
