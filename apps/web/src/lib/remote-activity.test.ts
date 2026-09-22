import { describe, it, expect } from "vitest";
import {
  activityForRun,
  reconcileApprovals,
  approvalAllowed,
  type RemoteActivity,
} from "./remote-activity";
describe("remote task context isolation", () => {
  it("never exposes the preceding run approvals between render and effect cleanup", () => {
    const previous = {
      identity: "run-old",
      run: { id: "run-old", state: "running" },
      approvals: [{ id: "approval-old", state: "pending" }],
      error: "old connection failure",
      loading: false,
    } as unknown as RemoteActivity & { identity: string };
    expect(activityForRun(previous, "run-new")).toEqual({
      run: null,
      approvals: [],
      error: "",
      loading: true,
    });
    expect(activityForRun(previous, undefined).approvals).toEqual([]);
    expect(activityForRun(previous, "run-old")).toBe(previous);
  });
  it("disables approvals immediately during cancellation and terminal states", () => {
    for (const state of [
      "queued",
      "cancelling",
      "cancelled",
      "succeeded",
      "failed",
      undefined,
    ])
      expect(approvalAllowed(state)).toBe(false);
    expect(approvalAllowed("preparing")).toBe(true);
    expect(approvalAllowed("running")).toBe(true);
  });
});

it("does not revive approved actions from an older pending poll, but accepts runner consumption", () => {
  const approval = {
    id: "a",
    state: "approved",
  } as RemoteActivity["approvals"][number];
  expect(
    reconcileApprovals([approval], [{ ...approval, state: "pending" }])[0]
      ?.state,
  ).toBe("approved");
  expect(
    reconcileApprovals([approval], [{ ...approval, state: "consumed" }])[0]
      ?.state,
  ).toBe("consumed");
});
