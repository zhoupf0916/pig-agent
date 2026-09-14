import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../agent/runtime.ts";
import { createApp } from "../app.ts";
import {
  BUNDLED_CODING_TEAM_ID,
  BUNDLED_IMPLEMENT_ID,
  BUNDLED_SCOUT_ID,
} from "./bundled-experts.ts";
import { resolveExpertPlaybook } from "./experts.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const pigSettings = {
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "test",
  llmModel: "deepseek-chat",
  workspaceRoot: "/tmp",
  runtime: "pig" as const,
  codexBinaryPath: "",
  codexModel: "deepseek-flash",
  codexNetworkAccess: false,
  cloudBaseUrl: "",
  cloudToken: "",
  cloudMode: "local-stub" as const,
};

describe("local experts registry", () => {
  const app = createApp();

  it("seeds bundled coding experts and the chain team", async () => {
    const listed = await json<{ experts: Array<{ id: string; bundled: boolean; name: string }> }>(
      await app.request("/api/experts"),
    );
    const ids = listed.experts.filter((e) => e.bundled).map((e) => e.id);
    expect(ids.slice(0, 4)).toEqual([
      BUNDLED_SCOUT_ID,
      "exp_plan",
      BUNDLED_IMPLEMENT_ID,
      "exp_review",
    ]);
    expect(listed.experts.find((e) => e.id === BUNDLED_IMPLEMENT_ID)?.name).toContain("实现");

    const teams = await json<{ teams: Array<{ id: string; mode: string; expertIds: string[] }> }>(
      await app.request("/api/expert-teams"),
    );
    const coding = teams.teams.find((t) => t.id === BUNDLED_CODING_TEAM_ID);
    expect(coding?.mode).toBe("chain");
    expect(coding?.expertIds).toContain(BUNDLED_SCOUT_ID);
  });

  it("creates, patches, and deletes a custom expert", async () => {
    const created = await app.request("/api/experts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "文档专家",
        description: "只写说明",
        instruction: "只更新 Markdown，不要改代码。",
        kind: "custom",
        skillIds: ["doc-writing"],
      }),
    });
    expect(created.status).toBe(201);
    const expert = await json<{ id: string; bundled: boolean; skillIds: string[] }>(created);
    expect(expert.bundled).toBe(false);
    expect(expert.skillIds).toEqual(["doc-writing"]);

    const patched = await app.request(`/api/experts/${expert.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "用中文写 README。" }),
    });
    expect(patched.status).toBe(200);
    expect((await json<{ instruction: string }>(patched)).instruction).toContain("README");

    const deleted = await app.request(`/api/experts/${expert.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await app.request(`/api/experts/${expert.id}`)).status).toBe(404);
  });

  it("refuses to delete bundled experts", async () => {
    const res = await app.request(`/api/experts/${BUNDLED_SCOUT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/Bundled/);
  });

  it("binds expertId on a session and injects expert before project", async () => {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "专家项目", instruction: "项目：交付前必须校验。" }),
      }),
    );
    const session = await json<{ id: string; expertId?: string; projectId?: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, expertId: BUNDLED_SCOUT_ID }),
      }),
    );
    expect(session.expertId).toBe(BUNDLED_SCOUT_ID);
    expect(session.projectId).toBe(project.id);

    const playbook = await resolveExpertPlaybook({ expertId: session.expertId });
    expect(playbook.instruction).toContain("Scout");
    expect(playbook.instruction).toContain("Do not change files");

    const prompt = await buildSystemPrompt(pigSettings, {
      expertInstruction: playbook.instruction,
      projectInstruction: "项目：交付前必须校验。",
    });
    expect(prompt.indexOf("Expert instructions")).toBeLessThan(prompt.indexOf("Project instructions"));
    expect(prompt).toContain("Do not change files");
    expect(prompt).toContain("交付前必须校验");

    const unbound = await json<{ expertId?: string }>(
      await app.request(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertId: null }),
      }),
    );
    expect(unbound.expertId).toBeUndefined();
  });

  it("resolves a team as concatenated roles when no expertId is pinned", async () => {
    const playbook = await resolveExpertPlaybook({ expertTeamId: BUNDLED_CODING_TEAM_ID });
    expect(playbook.instruction).toContain("编码流水线");
    expect(playbook.instruction).toContain("侦察 Scout");
    expect(playbook.instruction).toContain("实现 Implement");
    expect(playbook.skillIds).toContain("coding-helper");
  });

  it("lets expertId win over the team for injected text", async () => {
    const playbook = await resolveExpertPlaybook({
      expertId: BUNDLED_SCOUT_ID,
      expertTeamId: BUNDLED_CODING_TEAM_ID,
    });
    expect(playbook.expert?.id).toBe(BUNDLED_SCOUT_ID);
    expect(playbook.team?.id).toBe(BUNDLED_CODING_TEAM_ID);
    expect(playbook.instruction).toContain("Scout");
    expect(playbook.instruction).not.toContain("编码流水线");
  });

  it("creates a custom team and forbids deleting the bundled one", async () => {
    const created = await app.request("/api/expert-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "侦察+规划",
        mode: "parallel",
        expertIds: [BUNDLED_SCOUT_ID, "exp_plan"],
      }),
    });
    expect(created.status).toBe(201);
    const team = await json<{ id: string; mode: string }>(created);
    expect(team.mode).toBe("parallel");

    const bundled = await app.request(`/api/expert-teams/${BUNDLED_CODING_TEAM_ID}`, {
      method: "DELETE",
    });
    expect(bundled.status).toBe(400);

    const deleted = await app.request(`/api/expert-teams/${team.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });
});
