import { describe, it, expect, vi } from "vitest";
import { createProcessStopper } from "./stop-process.ts";
describe("native process cancellation", () => {
  it("coalesces cancellation and kills a still-running process group", async () => {
    const kill = vi.fn();
    let release!: () => void;
    const stopper = createProcessStopper(
      () => ({ pid: 42, exitCode: null, signalCode: null }),
      kill,
      () => new Promise((r) => (release = r)),
    );
    const one = stopper.stop();
    const two = stopper.stop();
    expect(one).toBe(two);
    expect(stopper.requested).toBe(true);
    expect(kill.mock.calls).toEqual([[-42, "SIGTERM"]]);
    release();
    await one;
    expect(kill.mock.calls).toEqual([
      [-42, "SIGTERM"],
      [-42, "SIGKILL"],
    ]);
  });
  it("does not kill a replaced or exited leader", async () => {
    const kill = vi.fn();
    let state = { pid: 42, exitCode: null as number | null, signalCode: null };
    const stopper = createProcessStopper(
      () => state,
      kill,
      async () => {
        state = { pid: 43, exitCode: null, signalCode: null };
      },
    );
    await stopper.stop();
    expect(kill).toHaveBeenCalledTimes(1);
    state.exitCode = 0;
    await stopper.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });
  it("retries failed stop instead of treating it as success", async () => {
    const kill = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const stopper = createProcessStopper(
      () => ({ pid: 42, exitCode: null, signalCode: null }),
      kill,
      async () => {},
    );
    await expect(stopper.stop()).rejects.toThrow("denied");
    await stopper.stop();
    expect(kill.mock.calls.at(-1)).toEqual([-42, "SIGKILL"]);
  });
});
