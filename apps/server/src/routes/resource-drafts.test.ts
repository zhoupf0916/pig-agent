import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
const state = vi.hoisted(() => ({ complete: vi.fn(), data: "" }));
vi.mock("../agent/openai.ts", () => ({ complete: state.complete }));
vi.mock("../config.ts", async importOriginal => ({ ...(await importOriginal<object>()), get DATA_DIR() { return state.data; } }));
vi.mock("../store/settings.ts", () => ({ loadSettings: async () => ({ llmBaseUrl: "https://example.invalid/v1", llmApiKey: "secret", llmModel: "test-model" }) }));
state.data = await mkdtemp(join(tmpdir(), "pig-drafts-"));
const { registerResourceDraftRoutes, parseResourceDraft } = await import("./resource-drafts.ts");
const { listSkills, loadSkill } = await import("../agent/skills.ts");
const app = new Hono();
registerResourceDraftRoutes(app);
const post = (path: string, value: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
afterAll(() => rm(state.data, { recursive: true, force: true }));
beforeEach(() => { state.complete.mockReset(); });

describe("resource drafts", () => {
  it("uses the configured model without tools, returning an editable draft without persisting", async () => {
    state.complete.mockResolvedValue({ content: JSON.stringify({ name: "draft-only", description: "分析数据", body: "先检查字段，再分析异常并验证。" }) });
    const response = await post("/api/resource-drafts", { kind: "skill", prompt: "分析销售异常" });
    expect(response.status).toBe(200);
    expect((await response.json() as { model: string }).model).toBe("test-model");
    expect(state.complete.mock.calls[0]?.[2]).toMatchObject({ allowTools: false, maxOutputTokens: 4000 });
    expect((await listSkills()).some(s => s.name === "draft-only")).toBe(false);
  });
  it("rejects invalid requests without spending a model call and does not expose provider secrets", async () => {
    expect((await post("/api/resource-drafts", { kind: "skill", prompt: " " })).status).toBe(400);
    expect(state.complete).not.toHaveBeenCalled();
    state.complete.mockRejectedValue(new Error("Authorization secret-token"));
    const response = await post("/api/resource-drafts", { kind: "expert", prompt: "产品评审专家" });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-token");
  });
  it("validates model JSON and accepts fenced output", () => {
    expect(parseResourceDraft("expert", '```json\n{"name":"产品专家","description":"评审","instruction":"检查验收标准"}\n```')).toMatchObject({ name: "产品专家" });
    expect(() => parseResourceDraft("skill", '{"name":"../../escape","description":"x","body":"x"}')).toThrow();
  });
  it("saves only explicit create requests to writable data and refuses duplicates or bundled overwrite", async () => {
    const skill = { name: "sales-check-user", description: "销售分析", body: "检查输入；标记异常；核对总额。" };
    expect((await post("/api/skills", skill)).status).toBe(201);
    expect((await loadSkill(skill.name)).body.trim()).toBe(skill.body);
    expect((await post("/api/skills", skill)).status).toBe(409);
    expect((await post("/api/skills", { ...skill, name: "coding-helper" })).status).toBe(409);
    expect((await post("/api/skills", { ...skill, name: "../escape" })).status).toBe(400);
    const named = await post("/api/skills", { name: "sales-check-named", displayName: "销售检查", description: "销售分析", body: "检查输入；标记异常；核对总额。" });
    expect(named.status).toBe(201);
    expect((await loadSkill("sales-check-named")).displayName).toBe("销售检查");
  });
});
