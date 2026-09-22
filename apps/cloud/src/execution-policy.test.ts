import { describe, expect, it } from "vitest";
import { executionPolicy } from "./execution-policy.ts";
const defaults = { requireApproval: true, networkPolicy: "blocked" as const };
describe("effective execution consent", () => {
  it("omission inherits safe account defaults, explicit false is never discarded", () => {
    expect(executionPolicy({}, defaults)).toEqual(defaults);
    expect(executionPolicy({ requireApproval: false }, defaults)).toEqual({
      ...defaults,
      requireApproval: false,
    });
    expect(
      executionPolicy(
        { requireApproval: true },
        { requireApproval: false, networkPolicy: "ask" },
      ),
    ).toEqual({ requireApproval: true, networkPolicy: "ask" });
  });
  it("automatic file operations never change the separate network policy", () => {
    expect(
      executionPolicy(
        { requireApproval: false, networkPolicy: "ask" },
        defaults,
      ),
    ).toEqual({ requireApproval: false, networkPolicy: "ask" });
  });
});
