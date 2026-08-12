// Centralised audit logger. Used by login, logout, password-change, and
// will be reused by every phase that records an admin-visible action
// (chat, tool calls, provider additions, etc.). Errors are logged but
// never throw — auditing is best-effort and must not break the request.

import { sql } from "../db/client.ts";

export interface AuditInput {
  userId: string | null;
  target: string;
  action: string;
  tokens?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function logAudit(input: AuditInput): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (user_id, target, action, tokens, metadata)
      VALUES (${input.userId}::uuid, ${input.target}, ${input.action},
              ${input.tokens ?? 0}, ${sql.json(input.metadata ?? {})})
    `;
  } catch (err) {
    console.warn("audit log failed:", (err as Error).message);
  }
}