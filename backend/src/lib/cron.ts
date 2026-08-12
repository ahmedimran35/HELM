// Real cron expression handling. Uses `cron-parser` so the schedule
// strings we accept match the de-facto Unix crontab syntax. Returns the
// next Date after `from`, or null if the expression is invalid.

import cronParser from "cron-parser";

export function computeNextRun(schedule: string, from: Date = new Date()): Date | null {
  try {
    const it = cronParser.parseExpression(schedule, { currentDate: from, tz: "UTC" });
    return it.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(schedule: string): boolean {
  try {
    cronParser.parseExpression(schedule, { currentDate: new Date(), tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}