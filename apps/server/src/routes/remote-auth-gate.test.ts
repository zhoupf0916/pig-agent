import { describe, expect, it } from "vitest";
import { createRemoteAuthGate } from "./remote-auth-gate.ts";
describe("remote authentication concurrency", () => {
  it("invalidates a late login when logout arrives and serializes credential mutations", async () => {
    const gate = createRemoteAuthGate();
    let release!: () => void;
    let token = "existing";
    const pending = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const login = gate(async (current) => {
      entered();
      await pending;
      if (current()) token = "late-login";
      return current();
    });
    await started;
    const logout = gate(async (current) => {
      expect(current()).toBe(true);
      token = "";
    });
    release();
    expect(await login).toBe(false);
    await logout;
    expect(token).toBe("");
  });
  it("only permits latest concurrent login, and failure never poisons the queue", async () => {
    const gate = createRemoteAuthGate();
    const stale = gate(async (current) => current());
    const latest = gate(async (current) => current());
    expect(await stale).toBe(false);
    expect(await latest).toBe(true);
    await expect(
      gate(async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await gate(async (current) => current())).toBe(true);
  });
});
