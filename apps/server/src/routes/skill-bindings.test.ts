import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const request = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("技能关联的用户可见校验", () => {
  it("创建专家时拒绝不存在的技能，且不保存残缺专家", async () => {
    const app = createApp();
    const response = await app.request("/api/experts", request({
      name: "不存在技能的专家", instruction: "检查输入", skillIds: ["missing-skill-proof"],
    }));
    expect(response.status).toBe(400);
    const { experts } = await (await app.request("/api/experts")).json() as { experts: Array<{ name: string }> };
    expect(experts.some((item: { name: string }) => item.name === "不存在技能的专家")).toBe(false);
  });

  it("更新专家到不可用技能失败后保留原有绑定", async () => {
    const app = createApp();
    const response = await app.request("/api/experts", request({
      name: "技能绑定保留验证", instruction: "写文档", skillIds: ["doc-writing"],
    }));
    expect(response.status).toBe(201);
    const expert = await response.json() as { id: string };
    const updated = await app.request(`/api/experts/${expert.id}`, request({ skillIds: ["missing-skill-proof"] }, "PATCH"));
    expect(updated.status).toBe(400);
    const persisted = await (await app.request(`/api/experts/${expert.id}`)).json() as { skillIds: string[] };
    expect(persisted.skillIds).toEqual(["doc-writing"]);
  });

  it("新对话拒绝未知的主动选择技能而不是静默忽略", async () => {
    const app = createApp();
    const response = await app.request("/api/sessions", request({ skillIds: ["missing-skill-proof"] }));
    expect(response.status).toBe(400);
  });
});
