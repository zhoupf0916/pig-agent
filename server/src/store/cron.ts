/**
 * Tiny cron matcher for local automations.
 * Supports 5-field cron plus `@hourly` / `@daily`. Evaluated in local time.
 */

export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
};

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
};

export function normalizeSchedule(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

export function resolveCronExpression(schedule: string): string {
  const trimmed = schedule.trim();
  if (ALIASES[trimmed]) return ALIASES[trimmed];
  return trimmed;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  if (!field || field === "*") {
    for (let i = min; i <= max; i++) values.add(i);
    return values;
  }
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    const range = pieces[0] ?? "";
    const stepRaw = pieces[1];
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step: ${part}`);
    }
    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    const bounds = range.split("-");
    const start = Number(bounds[0]);
    const end = bounds[1] == null ? start : Number(bounds[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: ${part}`);
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values;
}

export function parseCron(schedule: string): CronFields {
  const expr = resolveCronExpression(schedule);
  const parts = expr.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error("Schedule must be a 5-field cron, @hourly, or @daily");
  }
  const minute = parts[0];
  const hour = parts[1];
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new Error("Schedule must be a 5-field cron, @hourly, or @daily");
  }
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12),
    dayOfWeek: parseField(dayOfWeek, 0, 7),
  };
}

export function validateSchedule(raw: string | null | undefined): string | null {
  const schedule = normalizeSchedule(raw);
  if (!schedule) return null;
  parseCron(schedule);
  return schedule;
}

function dowMatches(field: Set<number>, dow: number): boolean {
  // 0 and 7 both mean Sunday.
  if (field.has(dow)) return true;
  if (dow === 0 && field.has(7)) return true;
  if (dow === 7 && field.has(0)) return true;
  return false;
}

export function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.dayOfMonth.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    dowMatches(fields.dayOfWeek, date.getDay())
  );
}

export function floorToMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

/**
 * Latest scheduled instant at or before `now` (minute precision), or null if none
 * in the lookback window (40 days).
 */
export function previousTick(schedule: string, now: Date, lookbackMinutes = 40 * 24 * 60): Date | null {
  const fields = parseCron(schedule);
  const cursor = floorToMinute(now);
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (cronMatches(fields, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

export function isScheduleDue(input: {
  schedule: string | null | undefined;
  lastRunAt?: string | null;
  createdAt: string;
  now: Date;
}): boolean {
  const schedule = normalizeSchedule(input.schedule);
  if (!schedule) return false;
  const prev = previousTick(schedule, input.now);
  if (!prev) return false;
  const since = new Date(input.lastRunAt || input.createdAt);
  if (Number.isNaN(since.getTime())) return false;
  return prev.getTime() > since.getTime();
}
