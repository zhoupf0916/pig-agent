export type SchedulePlan =
  | { kind: "manual" }
  | { kind: "hourly" }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string; days: number[] }
  | { kind: "custom"; cron: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export class SchedulePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulePlanError";
  }
}

function clock(time: string): { minute: string; hour: string } {
  const match = TIME.exec(time);
  if (!match) throw new SchedulePlanError("时间需要是 24 小时制，例如 09:00");
  return { hour: String(Number(match[1])), minute: String(Number(match[2])) };
}

export function planToCron(plan: SchedulePlan): string | null {
  if (plan.kind === "manual") return null;
  if (plan.kind === "hourly") return "0 * * * *";
  if (plan.kind === "custom") {
    const cron = plan.cron.trim();
    if (!cron) return null;
    if (!/^[\d\s*,/\-@]+$/.test(cron)) throw new SchedulePlanError("无法识别的执行计划");
    return cron;
  }
  const { minute, hour } = clock(plan.time);
  if (plan.kind === "daily") return `${minute} ${hour} * * *`;
  const days = [...new Set(plan.days)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
  if (!days.length) throw new SchedulePlanError("每周执行至少选择一天");
  return `${minute} ${hour} * * ${days.join(",")}`;
}

export function cronToPlan(cron: string | null | undefined): SchedulePlan {
  if (!cron) return { kind: "manual" };
  if (cron === "0 * * * *" || cron === "@hourly") return { kind: "hourly" };
  if (cron === "@daily" || cron === "0 0 * * *") return { kind: "daily", time: "00:00" };
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  if (daily) return { kind: "daily", time: pad(daily[2]!, daily[1]!) };
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/.exec(cron);
  if (weekly) return { kind: "weekdays", time: pad(weekly[2]!, weekly[1]!), days: weekly[3]!.split(",").map(Number) };
  return { kind: "custom", cron };
}

export function describePlan(plan: SchedulePlan): string {
  if (plan.kind === "manual") return "仅手动执行";
  if (plan.kind === "hourly") return "每小时";
  if (plan.kind === "daily") return `每天 ${plan.time}`;
  if (plan.kind === "weekdays") return `每${plan.days.map((day) => WEEKDAYS[day] ?? "").join("、")} ${plan.time}`;
  return plan.cron;
}

function pad(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function localLeaseDecision(input: {
  outcome: string;
  deviceId: string | null;
  leaseUntil: number | null;
  now: number;
  device: string;
}): "take" | "mine" | "busy" {
  if (input.outcome === "waiting_device") return "take";
  if (input.outcome !== "leased") return "busy";
  const expired = (input.leaseUntil ?? 0) <= input.now;
  if (input.deviceId === input.device && !expired) return "mine";
  if (expired) return "take";
  return "busy";
}
