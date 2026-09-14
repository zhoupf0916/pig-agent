import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

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

  it("lists shipped skills", async () => {
    const res = await app.request("/api/skills");
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    const names = body.skills.map((s) => s.name);
    expect(names).toContain("organize-workspace");
    expect(names).toContain("research-report");
    expect(names).toContain("coding-helper");
  });
});
