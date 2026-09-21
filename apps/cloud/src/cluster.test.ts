import { describe, it, expect } from "vitest";
import {
  defaultExecutionPolicy,
  executionPolicySchema,
  workerIdentitySchema,
} from "./cluster.ts";
describe("cluster policy validation", () => {
  it("accepts the operational defaults", () =>
    expect(executionPolicySchema.parse(defaultExecutionPolicy)).toEqual(
      defaultExecutionPolicy,
    ));
  it.each([
    "globalConcurrency",
    "userConcurrency",
    "projectConcurrency",
    "queueLimit",
    "queueTimeoutSeconds",
  ])("rejects disabled or fractional %s", (key) => {
    expect(
      executionPolicySchema.safeParse({ ...defaultExecutionPolicy, [key]: 0 })
        .success,
    ).toBe(false);
    expect(
      executionPolicySchema.safeParse({ ...defaultExecutionPolicy, [key]: 1.5 })
        .success,
    ).toBe(false);
  });
  it("rejects unknown switches instead of pretending to persist them", () =>
    expect(
      executionPolicySchema.safeParse({
        ...defaultExecutionPolicy,
        retryForever: true,
      }).success,
    ).toBe(false));
  it("requires a process generation separate from the configured node name", () => {
    expect(
      workerIdentitySchema.safeParse({ workerId: "node-a", instanceId: "old" })
        .success,
    ).toBe(false);
    expect(
      workerIdentitySchema.safeParse({
        workerId: "node-a",
        instanceId: "b0a48706-3c32-4c49-9501-45f0c8754e32",
      }).success,
    ).toBe(true);
  });
});
