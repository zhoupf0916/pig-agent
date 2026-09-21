import { describe, it, expect } from "vitest";
import { nextFire, missedFire } from "./schedule-time.ts";
describe("control-plane schedule time", () => {
  it("uses the selected timezone and advances strictly beyond a consumed firing", () => {
    const now = new Date("2026-09-21T00:00:00Z");
    const first = nextFire("0 9 * * *", "Asia/Shanghai", now)!;
    expect(first.toISOString()).toBe("2026-09-21T01:00:00.000Z");
    expect(nextFire("0 9 * * *", "Asia/Shanghai", first)!.toISOString()).toBe(
      "2026-09-22T01:00:00.000Z",
    );
  });
  it("handles DST without depending on the Docker host timezone", () => {
    expect(
      nextFire(
        "0 9 * * *",
        "America/New_York",
        new Date("2026-03-07T15:00:00Z"),
      )!.toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z");
  });
  it("supports manual-only and rejects seconds, ambiguous day rules and invalid timezone", () => {
    expect(nextFire(null, "UTC", new Date())).toBeNull();
    for (const cron of ["* * * * * *", "0 0 1 * 1", "0 99 * * *"])
      expect(() => nextFire(cron, "UTC", new Date())).toThrow();
    expect(() => nextFire("@daily", "not-a-timezone", new Date())).toThrow();
  });
  it("skips late firings only under the skip policy", () => {
    const due = new Date("2026-09-21T00:00:00Z");
    expect(missedFire(due, new Date(due.getTime() + 59_999), "skip")).toBe(
      false,
    );
    expect(missedFire(due, new Date(due.getTime() + 60_000), "skip")).toBe(
      true,
    );
    expect(missedFire(due, new Date(due.getTime() + 86400_000), "once")).toBe(
      false,
    );
  });
});
