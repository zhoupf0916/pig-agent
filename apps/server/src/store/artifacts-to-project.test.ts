import { describe, expect, it } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp } from "../app.ts";
import { nowIso } from "../util.ts";
import { saveSession } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import { assetDiskPath, getProject, uniqueAssetFilename } from "./projects.ts";
import type { Session } from "../types.ts";

async function seedWorkspace(relativePath: string, content: string): Promise<string> {
  const root = (await loadSettings()).workspaceRoot;
  const abs = join(root, relativePath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seedBoundSession(
  app: ReturnType<typeof createApp>,
  artifacts: Session["artifacts"],
  projectName = "产物归档",
): Promise<{ projectId: string; sessionId: string }> {
  const project = await json<{ id: string }>(
    await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName }),
    }),
  );
  const session = await json<Session>(
    await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    }),
  );
  session.artifacts = artifacts;
  await saveSession(session);
  return { projectId: project.id, sessionId: session.id };
}

describe("artifacts → project assets", () => {
  const app = createApp();

  it("saves a bound session artifact and overwrites the same path", async () => {
    await seedWorkspace("notes/todo.txt", "[ ] organize loose files\n");
    const { projectId, sessionId } = await seedBoundSession(app, [
      { path: "notes/todo.txt", action: "modified", updatedAt: nowIso() },
    ]);

    const first = await app.request(
      `/api/sessions/${sessionId}/artifacts/${encodeURIComponent("notes/todo.txt")}/save-to-project`,
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    const saved = await json<{
      projectId: string;
      overwritten: boolean;
      asset: { id: string; filename: string; sourceArtifactPath?: string };
    }>(first);
    expect(saved.projectId).toBe(projectId);
    expect(saved.overwritten).toBe(false);
    expect(saved.asset.filename).toBe("todo.txt");
    expect(saved.asset.sourceArtifactPath).toBe("notes/todo.txt");

    const again = await app.request(`/api/sessions/${sessionId}/artifacts/save-to-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/todo.txt" }),
    });
    expect(again.status).toBe(200);
    const second = await json<{ overwritten: boolean; asset: { id: string } }>(again);
    expect(second.overwritten).toBe(true);
    expect(second.asset.id).toBe(saved.asset.id);

    const project = await getProject(projectId);
    expect(project?.assets).toHaveLength(1);
    const disk = await readFile(assetDiskPath(projectId, project!.assets[0]!));
    expect(disk.toString("utf8")).toContain("organize loose files");
  });

  it("resolves a unique basename", async () => {
    await seedWorkspace("notes/todo.txt", "[ ] organize loose files\n");
    const { sessionId } = await seedBoundSession(app, [
      { path: "notes/todo.txt", action: "modified", updatedAt: nowIso() },
    ]);
    const byName = await app.request(
      `/api/sessions/${sessionId}/artifacts/todo.txt/save-to-project`,
      { method: "POST" },
    );
    expect(byName.status).toBe(200);
    expect((await json<{ asset: { filename: string } }>(byName)).asset.filename).toBe("todo.txt");
  });

  it("versions filenames when two artifact paths share a basename", async () => {
    const extra = await seedWorkspace("drafts/todo.txt", "drafts copy\n");
    await seedWorkspace("notes/todo.txt", "[ ] organize loose files\n");
    try {
      const { projectId, sessionId } = await seedBoundSession(app, [
        { path: "notes/todo.txt", action: "modified", updatedAt: nowIso() },
        { path: "drafts/todo.txt", action: "created", updatedAt: nowIso() },
      ]);
      const res = await app.request(`/api/sessions/${sessionId}/artifacts/save-all-to-project`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const project = await getProject(projectId);
      const names = (project?.assets.map((a) => a.filename) ?? []).sort();
      expect(names).toEqual(["todo-2.txt", "todo.txt"]);
    } finally {
      await unlink(extra).catch(() => undefined);
    }
  });

  it("uniqueAssetFilename increments the suffix", () => {
    expect(uniqueAssetFilename(["a.md"], "a.md")).toBe("a-2.md");
    expect(uniqueAssetFilename(["a.md", "a-2.md"], "a.md")).toBe("a-3.md");
  });

  it("rejects unbound sessions and missing / deleted artifacts", async () => {
    const unbound = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const noProject = await app.request(
      `/api/sessions/${unbound.id}/artifacts/todo.txt/save-to-project`,
      { method: "POST" },
    );
    expect(noProject.status).toBe(400);

    const { sessionId } = await seedBoundSession(app, [
      { path: "ghost.md", action: "created", updatedAt: nowIso() },
      { path: "notes/todo.txt", action: "deleted", updatedAt: nowIso() },
    ]);
    const missing = await app.request(
      `/api/sessions/${sessionId}/artifacts/no-such.md/save-to-project`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);

    const deleted = await app.request(
      `/api/sessions/${sessionId}/artifacts/${encodeURIComponent("notes/todo.txt")}/save-to-project`,
      { method: "POST" },
    );
    expect(deleted.status).toBe(400);
  });

  it("save-all copies existing files and skips deleted", async () => {
    await seedWorkspace("notes/todo.txt", "[ ] organize loose files\n");
    await seedWorkspace("drafts/idea.md", "idea\n");
    const { projectId, sessionId } = await seedBoundSession(app, [
      { path: "notes/todo.txt", action: "modified", updatedAt: nowIso() },
      { path: "drafts/idea.md", action: "created", updatedAt: nowIso() },
      { path: "gone.md", action: "deleted", updatedAt: nowIso() },
    ]);
    const res = await app.request(`/api/sessions/${sessionId}/artifacts/save-all-to-project`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json<{
      projectId: string;
      saved: Array<{ artifactPath: string; overwritten: boolean }>;
      skipped: Array<{ artifactPath: string; reason: string }>;
    }>(res);
    expect(body.projectId).toBe(projectId);
    expect(body.saved.map((s) => s.artifactPath).sort()).toEqual([
      "drafts/idea.md",
      "notes/todo.txt",
    ]);
    expect(body.skipped.some((s) => s.artifactPath === "gone.md" && s.reason === "deleted")).toBe(
      true,
    );
  });
});
