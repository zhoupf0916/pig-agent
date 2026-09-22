import {
  mkdtemp,
  realpath,
  rm,
  access,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createApp } from "../app.ts";
import { DATA_DIR } from "../config.ts";
import { createProject, deleteProject, getProject } from "./projects.ts";
import { deleteSession, getSession } from "./sessions.ts";
import type { Session } from "@pig-agent/contracts";

describe("multiple project workspaces", () => {
  it("persists explicit/default choices, serializes concurrent additions, and never mutates captured tasks or user directories", async () => {
    const dirs = (await Promise.all(
      [0, 1, 2].map(async () =>
        realpath(await mkdtemp(join(tmpdir(), "pig-multi-workspace-"))),
      ),
    )) as [string, string, string];
    const project = await createProject({
      name: "Multi workspace",
      workspaceRoot: dirs[0],
    });
    const app = createApp(),
      sessions: string[] = [];
    const request = async (path: string, method: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const [a, b] = await Promise.all(
        dirs
          .slice(1)
          .map((path, i) =>
            request(`/api/projects/${project.id}/workspaces`, "POST", {
              path,
              name: `Directory ${i}`,
            }),
          ),
      );
      expect(a!.status).toBe(201);
      expect(b!.status).toBe(201);
      const saved = (await getProject(project.id))!;
      expect(saved.workspaces).toHaveLength(3);
      const second = saved.workspaces!.find((w) => w.path === dirs[1])!;
      const selected = await request("/api/sessions", "POST", {
        projectId: project.id,
        workspaceId: second.id,
      });
      expect(selected.status).toBe(201);
      const task = (await selected.json()) as Session;
      sessions.push(task.id);
      expect(task.workspaceRoot).toBe(dirs[1]);
      expect(task.workspaceId).toBe(second.id);
      expect(
        (
          await request(
            `/api/projects/${project.id}/workspaces/${second.id}`,
            "PATCH",
            { setDefault: true, name: "Chosen" },
          )
        ).status,
      ).toBe(200);
      const next = (await (
        await request(`/api/projects/${project.id}/sessions`, "POST", {})
      ).json()) as Session;
      sessions.push(next.id);
      expect(next.workspaceRoot).toBe(dirs[1]);
      expect(next.workspaceName).toBe("Chosen");
      expect(
        (
          await request(`/api/projects/${project.id}/workspaces`, "POST", {
            path: dirs[1],
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request("/api/sessions", "POST", {
            projectId: project.id,
            workspaceId: "foreign-id",
          })
        ).status,
      ).toBe(400);
      expect(
        (await request("/api/sessions", "POST", { workspaceId: second.id }))
          .status,
      ).toBe(400);
      expect(
        (
          await request(
            `/api/projects/${project.id}/workspaces/${second.id}`,
            "DELETE",
          )
        ).status,
      ).toBe(200);
      expect((await getSession(task.id))!.workspaceRoot).toBe(dirs[1]);
      await access(dirs[1]);
      expect((await getProject(project.id))!.workspaceRoot).toBe(dirs[0]);
      for (const path of ["relative", join(dirs[0], "missing")])
        expect(
          (
            await request(`/api/projects/${project.id}/workspaces`, "POST", {
              path,
            })
          ).status,
        ).toBe(400);
    } finally {
      for (const id of sessions) await deleteSession(id);
      await deleteProject(project.id);
      for (const dir of dirs) {
        await access(dir);
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
  it("normalizes legacy workspaceRoot with stable ids without rewriting the project on read", async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "pig-legacy-workspace-")),
    );
    const project = await createProject({ name: "Legacy", workspaceRoot: dir });
    const file = join(DATA_DIR, "projects", project.id, "project.json");
    try {
      delete project.workspaces;
      delete project.defaultWorkspaceId;
      await writeFile(file, JSON.stringify(project));
      const before = await readFile(file, "utf8");
      const first = (await getProject(project.id))!,
        second = (await getProject(project.id))!;
      expect(first.workspaces![0]!.id).toBe(second.workspaces![0]!.id);
      expect(first.defaultWorkspaceId).toBe("ws_legacy");
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      await deleteProject(project.id);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
