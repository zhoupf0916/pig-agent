import { describe, expect, it } from "vitest";
import { cronToPlan, describePlan, localLeaseDecision, planToCron, SchedulePlanError } from "@pig-agent/contracts";

describe("human schedule plans", () => {
  it("turns a daily time into one cron firing and a readable label", () => {
    const plan = { kind: "daily" as const, time: "09:30" };
    expect(planToCron(plan)).toBe("30 9 * * *");
    expect(describePlan(plan)).toBe("每天 09:30");
    expect(cronToPlan("30 9 * * *")).toEqual(plan);
  });

  it("turns selected weekdays into one plan without asking for cron", () => {
    const plan = { kind: "weekdays" as const, time: "18:00", days: [1, 3, 5] };
    expect(planToCron(plan)).toBe("0 18 * * 1,3,5");
    expect(describePlan(plan)).toBe("每周一、周三、周五 18:00");
  });

  it("keeps an unrecognized existing cron instead of rewriting it", () => {
    expect(cronToPlan("15 8 1 * *")).toEqual({ kind: "custom", cron: "15 8 1 * *" });
    expect(planToCron({ kind: "manual" })).toBeNull();
    expect(() => planToCron({ kind: "weekdays", time: "09:00", days: [] })).toThrow(SchedulePlanError);
  });
});

describe("one device executes a local schedule", () => {
  const now = 1_000_000;
  it("lets the first device take a waiting firing and keeps the lease", () => {
    expect(localLeaseDecision({ outcome: "waiting_device", deviceId: null, leaseUntil: null, now, device: "mac" })).toBe("take");
    expect(localLeaseDecision({ outcome: "leased", deviceId: "mac", leaseUntil: now + 10, now, device: "mac" })).toBe("mine");
    expect(localLeaseDecision({ outcome: "leased", deviceId: "mac", leaseUntil: now + 10, now, device: "phone" })).toBe("busy");
  });
  it("lets another device take the firing after the lease expires", () => {
    expect(localLeaseDecision({ outcome: "leased", deviceId: "mac", leaseUntil: now, now, device: "phone" })).toBe("take");
  });
});
