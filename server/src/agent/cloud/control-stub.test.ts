import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudControlApp } from "./control-stub.ts";
import { packWorkspaceSnapshot } from "./snapshot.ts";

describe("in-repo cloud control stub", () => {
  it("accepts a snapshot, streams SSE, then follow-up", async () => {
    const source = mkdtempSync(join(tmpdir(), "pig-stub-src-"));
    writeFileSync(join(source, "readme.md"), "hello");
    writeFileSync(join(source, ".env"), "NOPE=1\n");
    const snapshot = packWorkspaceSnapshot(source);
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-stub-runs-"));
    const { app, runs } = createCloudControlApp({ runsRoot });

    const created = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "整理工作区",
        sessionId: "ses_1",
        workspace: { snapshot, repoUrl: "https://example.com/app.git", ref: "main" },
      }),
    });
    expect(created.status).toBe(200);
    const run = (await created.json()) as { id: string };
    expect(run.id).toMatch(/^run_/);
    const stored = runs.get(run.id);
    expect(stored?.files).toContain("readme.md");
    expect(stored?.files.some((f) => f.includes(".env"))).toBe(false);
    expect(stored?.repoUrl).toBe("https://example.com/app.git");

    const events = await app.request(`/v1/runs/${run.id}/events`);
    expect(events.status).toBe(200);
    const first = await events.text();
    expect(first).toContain("accepted workspace");
    expect(first).toContain("整理工作区");
    expect(first).not.toContain("NOPE=1");

    const follow = await app.request(`/v1/runs/${run.id}/follow-ups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "再写一个文件" }),
    });
    expect(follow.status).toBe(200);
    expect(await follow.json()).toMatchObject({ ok: true, id: run.id });

    const again = await app.request(`/v1/runs/${run.id}/events`);
    expect(await again.text()).toContain("[stub] follow-up: 再写一个文件");

    stored!.status = "expired";
    const missing = await app.request(`/v1/runs/${run.id}/follow-ups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "gone" }),
    });
    expect(missing.status).toBe(404);
  });
});
