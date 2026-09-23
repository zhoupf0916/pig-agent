import { describe, it, expect } from "vitest";
import { createApp } from "../app.ts";
import { pluginSkills, pluginExperts } from "./plugins.ts";
describe("built-in extension catalog", () => {
  it("installs a catalog pack disabled and makes its expert and skills available only while enabled", async () => {
    const app = createApp();
    const catalog = await app.request("/api/plugins/catalog");
    expect(catalog.status).toBe(200);
    const { catalog: items } = (await catalog.json()) as {
      catalog: { id: string }[];
    };
    expect(items.length).toBeGreaterThanOrEqual(5);
    const path = "/api/plugins/catalog/coding-quality";
    expect((await app.request(path, { method: "POST" })).status).toBe(201);
    expect(await pluginExperts()).toEqual([]);
    expect((await app.request(path, { method: "POST" })).status).toBe(409);
    const enabled = await app.request("/api/plugins/coding-quality", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(
      (await app.request("/api/plugins/coding-quality", { method: "DELETE" }))
        .status,
    ).toBe(409);
    expect(
      (await pluginExperts()).find(
        (e) => e.id === "plugin_coding-quality_quality-reviewer",
      )?.skillIds,
    ).toEqual(["plugin_coding-quality_review-checklist"]);
    expect(
      (await pluginSkills()).find(
        (s) => s.name === "plugin_coding-quality_review-checklist",
      )?.body,
    ).toContain("验证");
    await app.request("/api/plugins/coding-quality", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"enabled":false}',
    });
    expect(await pluginSkills()).toEqual([]);
    expect(
      (await app.request("/api/plugins/coding-quality", { method: "DELETE" }))
        .status,
    ).toBe(200);
  });
});
