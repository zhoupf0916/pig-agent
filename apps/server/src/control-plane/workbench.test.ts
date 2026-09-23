import { afterEach, describe, it, expect, vi } from "vitest";
import { createApp } from "../app.ts";
import { saveSettings } from "../store/settings.ts";
import { createAutomation, automationIsDue } from "../store/automations.ts";
import { runAutomation } from "../automations/run.ts";
const app = createApp();
afterEach(() => vi.restoreAllMocks());
describe("unified workbench control-plane boundaries", () => {
  it("keeps execution target and engine on the session and rejects unsupported remote Codex", async () => {
    const created = (await (
      await app.request("/api/sessions", { method: "POST" })
    ).json()) as { id: string };
    const patch = async (body: unknown) =>
      app.request(`/api/sessions/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await patch({ executionTarget: "remote", engine: "codex" })).status,
    ).toBe(400);
    const remote = await patch({ executionTarget: "remote", engine: "pig" });
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({
      executionTarget: "remote",
      engine: "pig",
    });
    await saveSettings({ runtime: "codex" });
    expect(
      await (await app.request(`/api/sessions/${created.id}`)).json(),
    ).toMatchObject({ executionTarget: "remote", engine: "pig" });
  });
  it("never executes legacy cloud schedules from the local timer", async () => {
    const row = await createAutomation({
      name: "Legacy",
      prompt: "x",
      runtime: "cloud",
      schedule: "* * * * *",
    });
    expect(automationIsDue(row, new Date(Date.now() + 3600000))).toBe(false);
    await expect(runAutomation(row.id)).rejects.toThrow("控制面");
  });
  it("limits the bridge to user execution APIs and injects stored credentials", async () => {
    await saveSettings({
      cloudBaseUrl: "http://127.0.0.1:8890",
      cloudToken: "test-plane-token",
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect((await app.request("/api/remote/v1/admin/overview")).status).toBe(
      404,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const r = await app.request("/api/remote/v1/runs", {
      headers: { Authorization: "Bearer renderer-supplied" },
    });
    expect(r.status).toBe(200);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer test-plane-token" },
    });
    expect(await r.text()).not.toContain("test-plane-token");
  });
  it("stores approval required when remote is selected without touching the checkbox", async () => {
    const created = (await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string; remoteRequireApproval?: boolean };
    const remote = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionTarget: "remote", engine: "pig" }),
    });
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({ executionTarget: "remote", remoteRequireApproval: true });
    const off = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionTarget: "remote", engine: "pig", remoteRequireApproval: false }),
    });
    expect(await off.json()).toMatchObject({ remoteRequireApproval: false });
    const again = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionTarget: "remote", engine: "pig" }),
    });
    expect(await again.json()).toMatchObject({ remoteRequireApproval: false });
  });
  it("keeps remote debug content off unless this session opts in", async () => {
    const created = (await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string; remoteDebugContent?: boolean };
    expect(created.remoteDebugContent).toBeUndefined();
    const bad = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteDebugContent: "yes" }),
    });
    expect(bad.status).toBe(400);
    const enabled = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteDebugContent: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ remoteDebugContent: true });
    const next = (await (await app.request("/api/sessions", { method: "POST" })).json()) as { id: string; remoteDebugContent?: boolean };
    expect(next.remoteDebugContent).toBeUndefined();
    const local = await app.request(`/api/sessions/${next.id}/debug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: true }),
    });
    expect(local.status).toBe(200);
    expect(await (await app.request(`/api/sessions/${next.id}`)).json()).not.toMatchObject({ remoteDebugContent: true });
    const cleared = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteDebugContent: false }),
    });
    expect(await cleared.json()).not.toMatchObject({ remoteDebugContent: true });
  });
  it("proxies a remote debug read and refuses to enable capture through the bridge", async () => {
    await saveSettings({ cloudBaseUrl: "http://127.0.0.1:9", cloudToken: "test-plane-token" });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ spans: [] }), { headers: { "Content-Type": "application/json" } }),
    );
    const read = await app.request("/api/remote/v1/runs/run_debug/debug");
    expect(read.status).toBe(200);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("/v1/runs/run_debug/debug");
    const callsBefore = fetcher.mock.calls.length;
    const write = await app.request("/api/remote/v1/runs/run_debug/debug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugContent: true }),
    });
    expect(write.status).toBe(404);
    expect(fetcher.mock.calls.length).toBe(callsBefore);
  });
  it("does not disguise failed remote creation as successful local creation", async () => {
    await saveSettings({
      cloudBaseUrl: "http://127.0.0.1:8890",
      cloudToken: "test",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "quota" }), { status: 429 }),
    );
    const r = await app.request("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Remote",
        prompt: "x",
        executionTarget: "remote",
      }),
    });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "quota" });
  });
});
