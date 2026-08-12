import { sql } from "../../db/client.ts";
import type { MemoryEntry, MemoryScope, MemoryStrategy } from "./types.ts";

export class RowsStrategy implements MemoryStrategy {
  kind = "rows" as const;
  constructor(public readonly config: Record<string, unknown> = {}) {}

  async recall(query: string, scope: MemoryScope, scopeId: string | null, limit: number): Promise<MemoryEntry[]> {
    const pattern = `%${query}%`;
    return sql<MemoryEntry[]>`
      SELECT m.id, m.user_id, u.name AS user_name, m.text, m.source_type,
             m.source_id, m.scope, m.created_at, m.metadata
      FROM memory_entries m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.scope = ${scope}
        AND (${scope}::text <> 'personal' OR m.user_id = ${scopeId}::uuid)
        AND m.text ILIKE ${pattern}
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
  }

  async ingest(entry: MemoryEntry, scope: MemoryScope, _scopeId: string | null): Promise<void> {
    await sql`
      INSERT INTO memory_entries (id, user_id, text, source_type, source_id, scope, metadata)
      VALUES (${entry.id}::uuid, ${entry.user_id}::uuid, ${entry.text}, ${entry.source_type},
              ${entry.source_id}::uuid, ${scope}, ${JSON.stringify(entry.metadata ?? {})}::jsonb)
    `;
  }
}
