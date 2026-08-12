// Knowledge retrieval: given a panel + a query, find the top-K most
// relevant chunks using Postgres full-text search. Real text matching
// via tsvector — no fake similarity scores, just the rank returned by
// `ts_rank_cd`. The retrieved chunks are returned as a single string
// that callers can inject into the system prompt.

import { sql } from "../db/client.ts";

export interface RetrievedChunk {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  rank: number;
}

export async function retrieveForPanel(
  panelId: string,
  query: string,
  topK = 4,
): Promise<RetrievedChunk[]> {
  const q = query.trim();
  if (!q) return [];
  // Use plainto_tsquery so user queries don't need to know tsquery
  // operators; websearch_to_tsquery would also work.
  const rows = await sql<{
    doc_id: string;
    doc_name: string;
    chunk_index: number;
    content: string;
    rank: number;
  }[]>`
    SELECT kc.doc_id, kd.name AS doc_name, kc.chunk_index, kc.content,
           ts_rank_cd(kc.search_tsv, plainto_tsquery('english', ${q})) AS rank
    FROM knowledge_chunks kc JOIN knowledge_docs kd ON kd.id = kc.doc_id
    WHERE kc.panel_id = ${panelId}::uuid
      AND kc.search_tsv @@ plainto_tsquery('english', ${q})
    ORDER BY rank DESC
    LIMIT ${topK}
  `;
  return rows.map((r) => ({
    docId: r.doc_id,
    docName: r.doc_name,
    chunkIndex: r.chunk_index,
    content: r.content,
    rank: r.rank,
  }));
}

export function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => `[#${i + 1} from ${c.docName}]\n${c.content}`)
    .join("\n\n");
  return `Use the following panel knowledge if relevant:\n\n${body}`;
}