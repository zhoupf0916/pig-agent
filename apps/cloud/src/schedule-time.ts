import { CronExpressionParser } from "cron-parser";

export class InvalidScheduleError extends Error {}

/** Five fields only: second-level schedules would overwhelm the execution pool. */
export function nextFire(
  cron: string | null,
  timezone: string,
  after: Date,
): Date | null {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
    if (!cron) return null;
    const expression =
      cron === "@hourly" ? "0 * * * *" : cron === "@daily" ? "0 0 * * *" : cron;
    if (
      !/^[\d\s*,/\-]+$/.test(expression) ||
      expression.trim().split(/\s+/).length !== 5
    )
      throw Error("计划需为五段 cron、@hourly 或 @daily");
    return CronExpressionParser.parse(`0 ${expression}`, {
      currentDate: after,
      tz: timezone,
      strict: true,
    })
      .next()
      .toDate();
  } catch {
    throw new InvalidScheduleError("cron 或时区无效（日期与星期不能同时限定）");
  }
}

export function missedFire(due: Date, now: Date, policy: string): boolean {
  return policy === "skip" && now.getTime() - due.getTime() >= 60_000;
}
