import { describe, expect, it } from "vitest";
import { isScheduleDue, parseCron, previousTick, validateSchedule } from "./cron.ts";

function local(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe("cron schedule", () => {
  it("normalizes @hourly / @daily and rejects junk", () => {
    expect(validateSchedule("@hourly")).toBe("@hourly");
    expect(validateSchedule("@daily")).toBe("@daily");
    expect(validateSchedule("0 9 * * 1")).toBe("0 9 * * 1");
    expect(validateSchedule("")).toBeNull();
    expect(validateSchedule(null)).toBeNull();
    expect(() => parseCron("not-a-cron")).toThrow(/5-field/);
    expect(() => parseCron("@weekly")).toThrow(/5-field/);
  });

  it("finds the previous @hourly tick with a fake clock", () => {
    const now = local(2026, 9, 14, 10, 17);
    const prev = previousTick("@hourly", now);
    expect(prev?.getHours()).toBe(10);
    expect(prev?.getMinutes()).toBe(0);
  });

  it("is due after the next cron instant since lastRunAt / createdAt", () => {
    const created = local(2026, 9, 14, 9, 15).toISOString();
    const now = local(2026, 9, 14, 10, 0);
    expect(
      isScheduleDue({
        schedule: "@hourly",
        createdAt: created,
        lastRunAt: null,
        now,
      }),
    ).toBe(true);
    expect(
      isScheduleDue({
        schedule: "@hourly",
        createdAt: created,
        lastRunAt: local(2026, 9, 14, 10, 0).toISOString(),
        now,
      }),
    ).toBe(false);
    expect(
      isScheduleDue({
        schedule: "@hourly",
        createdAt: created,
        lastRunAt: local(2026, 9, 14, 9, 0).toISOString(),
        now,
      }),
    ).toBe(true);
    expect(
      isScheduleDue({
        schedule: null,
        createdAt: created,
        now,
      }),
    ).toBe(false);
  });

  it("does not fire a brand-new @daily until midnight", () => {
    const created = local(2026, 9, 14, 15, 30).toISOString();
    expect(
      isScheduleDue({
        schedule: "@daily",
        createdAt: created,
        now: local(2026, 9, 14, 16, 0),
      }),
    ).toBe(false);
    expect(
      isScheduleDue({
        schedule: "@daily",
        createdAt: created,
        now: local(2026, 9, 15, 0, 0),
      }),
    ).toBe(true);
  });
});
