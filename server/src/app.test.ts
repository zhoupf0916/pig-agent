import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadSettings } from "./store/settings.ts";

describe("HTTP API", () => {
  const app = createApp();

  it("serves health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "pig-agent" });
  });

  it("lists sample workspace files", async () => {
    const res = await app.request("/api/workspace/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: { children?: Array<{ name: string }> } };
    const names = (body.tree.children ?? []).map((c) => c.name);
    expect(names).toContain("notes");
    expect(names).toContain("drafts");
  });

  it("GET /api/workspace/tree is a read-only snapshot (no secrets, no settings write)", async () => {
    const before = await loadSettings();
    const res = await app.request("/api/workspace/tree");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root?: string; tree: { name?: string; type?: string } };
    expect(body.tree?.type).toBe("dir");
    expect(JSON.stringify(body)).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    const after = await loadSettings();
    expect(after).toEqual(before);
    expect(after.runtime).toBe("pig");
  });

  it("rejects workspace path escapes", async () => {
    const res = await app.request("/api/workspace/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../package.json" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("creates and reads a session", async () => {
    const created = await app.request("/api/sessions", { method: "POST" });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string; title: string };
    const got = await app.request(`/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { id: string }).id).toBe(session.id);
  });

  it("defaults settings runtime to pig", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runtime: string;
      codexNetworkAccess: boolean;
      cloudMode?: string;
      cloudRepoUrl?: string;
      cloudRepoRef?: string;
      cloudStatus?: { envJson?: { file?: string } };
      executionSurface?: { runtime?: string; kind?: string; label?: string };
    };
    expect(body.runtime).toBe("pig");
    expect(body.codexNetworkAccess).toBe(false);
    expect(body.cloudMode ?? "local-stub").toBe("local-stub");
    expect(body.cloudRepoUrl ?? "").toBe("");
    expect(body.cloudRepoRef ?? "").toBe("");
    expect(body.cloudStatus?.envJson?.file).toBe("env.json");
    expect(body.executionSurface?.runtime).toBe("pig");
    expect(body.executionSurface?.kind).toBe("pig");
    expect(body.executionSurface?.label).toBe("本机 Pig");
    expect(JSON.stringify(body.executionSurface)).not.toMatch(
      /llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /,
    );
  });

  it("GET /api/settings is a read-only snapshot for the runtime chip", async () => {
    const before = await loadSettings();
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executionSurface?: { runtime?: string; label?: string } };
    expect(body.executionSurface?.runtime).toBe(before.runtime);
    expect(body.executionSurface?.label).toBeTruthy();
    const after = await loadSettings();
    expect(after).toEqual(before);
  });

  it("rejects remote cloud settings without a control-plane URL", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "cloud", cloudMode: "remote", cloudBaseUrl: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/未配置控制面 URL/);
  });

  it("lists shipped skills", async () => {
    const res = await app.request("/api/skills");
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    const names = body.skills.map((s) => s.name);
    expect(names).toContain("organize-workspace");
    expect(names).toContain("research-report");
    expect(names).toContain("coding-helper");
  });
});
