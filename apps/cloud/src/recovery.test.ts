import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
vi.mock("./db.ts", () => ({ db: { query: vi.fn() }, hash: (s: string) => `hash:${s}` }));
import { db } from "./db.ts";
import { registerRecoveryRoutes, recoveryDisposition } from "./recovery.ts";
import type { CloudEnv } from "./types.ts";
const app = new Hono<CloudEnv>(); registerRecoveryRoutes(app);
beforeEach(() => vi.mocked(db.query).mockReset());
const request = (body: unknown) => app.request("/internal/checkpoint", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
describe("safe recovery boundary", () => {
  it("rejects an expired attempt before acknowledging a tool boundary", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    expect((await request({ token: "test", phase: "unsafe" })).status).toBe(409);
  });
  it("acknowledges the durable unsafe boundary", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ id: "r" }], rowCount: 1 } as never);
    expect((await request({ token: "test", phase: "unsafe" })).status).toBe(200);
  });
  it("rejects safe checkpoints without complete workspace and messages", async () => {
    expect((await request({ token: "test", phase: "safe", checkpoint: {} })).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("reschedules only a safe interrupted execution", () => {
    expect(recoveryDisposition({ state: "running", phase: "safe", recoveries: 0, expiredDeadline: false })).toBe("queued");
    expect(recoveryDisposition({ state: "running", phase: "unsafe", recoveries: 0, expiredDeadline: false })).toBe("failed");
  });
  it("does not recover cancelled, timed out or exhausted executions", () => {
    expect(recoveryDisposition({ state: "cancelling", phase: "safe", recoveries: 0, expiredDeadline: false })).toBe("cancelled");
    expect(recoveryDisposition({ state: "running", phase: "safe", recoveries: 0, expiredDeadline: true })).toBe("failed");
    expect(recoveryDisposition({ state: "running", phase: "safe", recoveries: 2, expiredDeadline: false })).toBe("failed");
  });
});
