import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./db.ts", () => ({ db: mocks, hash: () => "hash" }));
vi.mock("./platform.ts", () => ({ decryptSecret: () => "test-secret" }));
import {
  listCapabilities,
  resolveCapabilityContext,
  parseCloudDraft,
  registerCapabilityRoutes,
} from "./capabilities.ts";
import type { CloudEnv } from "./types.ts";
beforeEach(() => {
  mocks.query.mockReset();
  mocks.connect.mockReset();
});
describe("cloud capability library", () => {
  it("loads existing shipped content and resolves only caller-owned resources", async () => {
    mocks.query.mockImplementation(async (_sql, args) => ({
      rows:
        _sql.includes("cloud_capabilities") && args[0] === "alice"
          ? [
              {
                id: args[1] === "expert" ? "exp_private" : "skill_private",
                value:
                  args[1] === "expert"
                    ? {
                        name: "Private expert",
                        description: "",
                        instruction: "EXPERT_PROOF",
                        skillIds: ["skill_private"],
                      }
                    : {
                        name: "Private skill",
                        description: "",
                        body: "SKILL_PROOF",
                      },
              },
            ]
          : [],
    }));
    expect(
      (await listCapabilities("bob", "expert")).some(
        (e) => e.id === "exp_scout",
      ),
    ).toBe(true);
    expect(
      (await listCapabilities("bob", "skill")).some(
        (e) => e.id === "coding-helper",
      ),
    ).toBe(true);
    const context = await resolveCapabilityContext("alice", {
      expertId: "exp_private",
    });
    expect(context).toContain("EXPERT_PROOF");
    expect(context).toContain("SKILL_PROOF");
    expect(context).toContain("不扩大工具");
    await expect(
      resolveCapabilityContext("bob", { expertId: "exp_private" }),
    ).rejects.toThrow("不属于当前账户");
    await expect(
      resolveCapabilityContext("bob", { skillIds: ["skill_private"] }),
    ).rejects.toThrow();
  });
  it("rejects invalid or oversized drafts and accepts editable structured model response", () => {
    expect(
      parseCloudDraft(
        "skill",
        '```json\n{"name":"分析","description":"校验","body":"先读取后复核"}\n```',
      ),
    ).toMatchObject({ name: "分析", body: "先读取后复核" });
    expect(() =>
      parseCloudDraft(
        "expert",
        '{"name":"专家","instruction":"","owner_id":"victim"}',
      ),
    ).toThrow();
  });
  it("requires configured provider and reserves the caller daily budget before generation", async () => {
    const app = new Hono<CloudEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "alice", name: "Alice", role: "member" });
      await next();
    });
    registerCapabilityRoutes(app);
    const send = () =>
      app.request("/v1/resource-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "skill", prompt: "分析销售数据" }),
      });
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await send()).status).toBe(503);
    mocks.query.mockResolvedValue({
      rows: [
        {
          base_url: "https://example.invalid/v1",
          secret: "encrypted",
          model: "model",
        },
      ],
    });
    const query = vi
      .fn()
      .mockImplementation(async (sql) => ({
        rows: sql.includes("daily_call_limit")
          ? [{ enabled: true, daily_call_limit: 0 }]
          : sql.includes("count(*)")
            ? [{ count: 0 }]
            : [],
      }));
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect((await send()).status).toBe(429);
      expect(fetch).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("generates a validated editable draft after billing, without persisting library content", async () => {
    const app = new Hono<CloudEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "alice", name: "Alice", role: "member" });
      await next();
    });
    registerCapabilityRoutes(app);
    mocks.query.mockResolvedValue({
      rows: [
        {
          base_url: "https://example.invalid/v1",
          secret: "encrypted",
          model: "test-provider",
        },
      ],
    });
    const query = vi
      .fn()
      .mockImplementation(async (sql) => ({
        rows: sql.includes("daily_call_limit")
          ? [{ enabled: true, daily_call_limit: 10 }]
          : sql.includes("count(*)")
            ? [{ count: 1 }]
            : sql.includes("reserve_model_budget")
              ? [{ id: "1" }]
              : [],
      }));
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    name: "核验专家",
                    description: "校验数据",
                    instruction: "先检查输入，再复核结果。",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    try {
      const response = await app.request("/v1/resource-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "expert", prompt: "帮我校验销售数据" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: "test-provider",
        draft: { name: "核验专家" },
      });
      const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(payload.tools).toBeUndefined();
      expect(payload.max_tokens).toBe(4000);
      expect(
        query.mock.calls.some((call) =>
          String(call[0]).includes("reserve_model_budget"),
        ),
      ).toBe(true);
      expect(
        [...query.mock.calls, ...mocks.query.mock.calls].some((call) =>
          String(call[0]).includes("INSERT INTO cloud_capabilities"),
        ),
      ).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });
});
