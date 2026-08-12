import { sql } from "../../db/client.ts";
import type { MemoryEntry, MemoryScope, MemoryStrategy } from "./types.ts";

export class SummaryStrategy implements MemoryStrategy {
  kind = "summary" as const;
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

  async summarize(entries: MemoryEntry[]): Promise<string> {
    return entries.map((entry) => entry.text).join("\n");
  }

  async summarizePending(scope: MemoryScope, scopeId: string | null): Promise<number> {
    const olderThanHours = Number(this.config.older_than_hours ?? 24);
    const entries = await sql<MemoryEntry[]>`
      SELECT id, user_id, text, source_type, source_id, scope, created_at, metadata
      FROM memory_entries
      WHERE scope = ${scope}
        AND (${scope}::text <> 'personal' OR user_id = ${scopeId}::uuid)
        AND created_at < now() - (${olderThanHours} || ' hours')::interval
        AND COALESCE(metadata->>'summary', 'false') <> 'true'
      ORDER BY created_at ASC
      LIMIT 500
    `;
    if (entries.length === 0) return 0;
    const text = await this.summarize(entries);
    const sourceIds = entries.map((entry) => entry.id);
    const userId = entries.find((entry) => entry.user_id)?.user_id ?? null;
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO memory_entries (user_id, text, source_type, scope, metadata)
        VALUES (${userId}::uuid, ${text}, 'summary', ${scope},
                ${JSON.stringify({ summary: true, source_ids: sourceIds, older_than_hours: olderThanHours })}::jsonb)
      `;
      await tx`DELETE FROM memory_entries WHERE id IN ${tx(sourceIds)}`;
    });
    return entries.length;
  }
}
