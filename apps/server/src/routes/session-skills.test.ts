import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { getSession, saveSession } from "../store/sessions.ts";

const json = async <T>(res: Response) => (await res.json()) as T;

describe("session skill snapshots", () => {
  const app = createApp();

  it("PATCH stores skillIds and keeps that snapshot after the library copy changes", async () => {
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = await json<{ id: string }>(created);
    const patched = await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: ["doc-writing"] }),
    });
    expect(patched.status).toBe(200);
    const saved = await json<{ skillIds: string[]; skillSnapshots: Array<{ id: string; body: string }> }>(patched);
    expect(saved.skillIds).toEqual(["doc-writing"]);
    expect(saved.skillSnapshots[0]?.body).toContain("文档");
    const stored = await getSession(session.id);
    expect(stored?.skillSnapshots?.[0]?.body).toContain("文档");
  });

  it("rejects unknown skills and does not keep a partial binding", async () => {
    const created = await json<{ id: string }>(await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    const patched = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: ["missing-skill-proof"] }),
    });
    expect(patched.status).toBe(400);
    expect((await getSession(created.id))?.skillIds).toBeUndefined();
  });

  it("clears explicit skills when the array is empty and refuses changes while running", async () => {
    const created = await json<{ id: string }>(await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: ["doc-writing"] }),
    }));
    const cleared = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [] }),
    });
    expect(cleared.status).toBe(200);
    expect((await json<{ skillIds?: string[] }>(cleared)).skillIds).toBeUndefined();
    const session = await getSession(created.id);
    session!.status = "running";
    await saveSession(session!);
    const denied = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: ["doc-writing"] }),
    });
    expect(denied.status).toBe(409);
    expect((await getSession(created.id))?.skillIds).toBeUndefined();
  });

  it("freezes the expert's skills into the session snapshot", async () => {
    const expert = await json<{ id: string }>(await app.request("/api/experts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "文档快照专家", instruction: "按技能写", skillIds: ["doc-writing"] }),
    }));
    const created = await json<{ id: string; skillSnapshots?: Array<{ name: string }> }>(await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expertId: expert.id }),
    }));
    expect(created.skillSnapshots?.some((skill) => skill.name === "doc-writing")).toBe(true);
  });
});
