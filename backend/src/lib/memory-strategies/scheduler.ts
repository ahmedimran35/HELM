import { sql } from "../../db/client.ts";
import { summarizeStrategy } from "./index.ts";

let timer: ReturnType<typeof setInterval> | undefined;

export function startMemoryScheduler(): void {
  if (timer) return;
  timer = setInterval(async () => {
    // Each strategy applies its own older_than_hours configuration; a no-op
    // summary strategy simply returns zero when it has no pending entries.
    const strategies = await sql<{ id: string }[]>`
      SELECT id FROM memory_strategies WHERE enabled AND kind = 'summary'
    `;
    await Promise.allSettled(strategies.map((strategy) => summarizeStrategy(strategy.id)));
  }, 60_000);
}
