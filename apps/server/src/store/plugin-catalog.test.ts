import { describe, it, expect } from "vitest";
import { createApp } from "../app.ts";
import { pluginSkills, pluginExperts } from "./plugins.ts";
describe("built-in extension catalog", () => {
  it.each(['idea-studio', 'sprint-planner', 'ux-lab', 'delight-design', 'storyboard-studio', 'game-lab'])("installs curated pack %s with its source, license and usable expert skill binding", async id => {
    const app = createApp();
    expect((await app.request(`/api/plugins/catalog/${id}`, {method: 'POST'})).status).toBe(201);
    expect((await app.request(`/api/plugins/${id}`, {method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled: true})})).status).toBe(200);
    const selected = (await pluginExperts()).find(e => e.id === `plugin_${id}_${id}-expert`);
    const playbook = (await pluginSkills()).find(s => s.name === selected?.skillIds[0]);
    expect(playbook?.body).toContain('https://github.com/');
    expect(playbook?.body).toContain('MIT License');
    expect(playbook?.body).toContain('交付');
    await app.request(`/api/plugins/${id}`, {method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled:false})});
    expect((await app.request(`/api/plugins/${id}`, {method:'DELETE'})).status).toBe(200);
  });
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
