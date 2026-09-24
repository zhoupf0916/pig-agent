import { beforeEach, describe, expect, it, vi } from "vitest";

const planeJson = vi.hoisted(() => vi.fn());
vi.mock("../control-plane/client.ts", () => ({ planeJson }));
import { pullLocalSchedules } from "./control-schedules.ts";

beforeEach(() => planeJson.mockReset());

describe("local schedule deliveries", () => {
  it("passes the control-plane skill snapshot into the local run", async () => {
    const scheduledAt = new Date().toISOString();
    planeJson.mockImplementation(async (path: string) => {
      if (path === "/v1/schedule-deliveries") {
        return {
          deliveries: [{
            scheduleId: "ratm_test",
            prompt: "跑技能",
            scheduledAt,
            skillSnapshots: [{ id: "audit-pack", name: "audit-pack", description: "验证", body: "调度快照", files: [] }],
          }],
        };
      }
      return {};
    });
    const seen: string[] = [];
    const ran = await pullLocalSchedules(async (item) => {
      seen.push(item.skillSnapshots?.[0]?.body || "");
    });
    expect(ran).toBe(1);
    expect(seen).toEqual(["调度快照"]);
  });
});
