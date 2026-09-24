import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceFileRevision } from "@pig-agent/contracts";
import { createApp } from "../app.ts";
import { createSession, saveSession } from "../store/sessions.ts";
import { trackWorkspaceTurn } from "../store/workspace-edits.ts";
import { saveSettings } from "../store/settings.ts";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

describe("workspace file edits", () => {
  const app = createApp();

  it("saves an edit into the workspace and keeps the previous text for the next read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-file-edit-"));
    await saveSettings({ workspaceRoot: root, runtime: "pig" });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes/todo.txt"), "旧内容\n", "utf8");
    const opened = await app.request("/api/workspace/file?path=notes/todo.txt");
    expect(opened.status).toBe(200);
    const current = await opened.json() as { revision: string; content: string };
    expect(current.revision).toBe(workspaceFileRevision("旧内容\n"));
    const saved = await app.request("/api/workspace/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/todo.txt", content: "新内容\n", baseRevision: current.revision }),
    });
    expect(saved.status).toBe(200);
    const next = await (await app.request("/api/workspace/file?path=notes/todo.txt")).json() as { content: string; revision: string };
    expect(next.content).toBe("新内容\n");
    const history = await (await app.request("/api/workspace/file/history?path=notes/todo.txt")).json() as { versions: Array<{ content: string }> };
    expect(history.versions.some((item) => item.content === "旧内容\n")).toBe(true);
  });

  it("rejects a stale edit and a write while a task is using the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-file-conflict-"));
    await saveSettings({ workspaceRoot: root, runtime: "pig" });
    await writeFile(join(root, "note.txt"), "当前\n", "utf8");
    const revision = workspaceFileRevision("当前\n");
    const stale = await app.request("/api/workspace/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "note.txt", content: "过期\n", baseRevision: "0".repeat(16) }),
    });
    expect(stale.status).toBe(409);
    expect(await (await app.request("/api/workspace/file?path=note.txt")).json()).toMatchObject({ content: "当前\n" });
    const session = await createSession();
    session.status = "running";
    session.executionTarget = "local";
    session.workspaceRoot = root;
    await saveSession(session);
    const busy = await app.request("/api/workspace/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "note.txt", content: "冲突\n", baseRevision: revision }),
    });
    expect(busy.status).toBe(409);
    expect(await (await app.request("/api/workspace/file?path=note.txt")).json()).toMatchObject({ content: "当前\n" });
  });

  it("keeps both workspaces' history when two roots save at once, and blocks a save during a local turn", async () => {
    const left = await mkdtemp(join(tmpdir(), "pig-file-left-"));
    const right = await mkdtemp(join(tmpdir(), "pig-file-right-"));
    await writeFile(join(left, "note.txt"), "左\n", "utf8");
    await writeFile(join(right, "note.txt"), "右\n", "utf8");
    const { saveWorkspaceFileEdit, workspaceFileHistory } = await import("../store/workspace-edits.ts");
    const [savedLeft, savedRight] = await Promise.all([
      saveWorkspaceFileEdit({ workspaceRoot: left, path: "note.txt", content: "左新\n", baseRevision: workspaceFileRevision("左\n") }),
      saveWorkspaceFileEdit({ workspaceRoot: right, path: "note.txt", content: "右新\n", baseRevision: workspaceFileRevision("右\n") }),
    ]);
    expect(savedLeft).toMatchObject({ path: "note.txt" });
    expect(savedRight).toMatchObject({ path: "note.txt" });
    expect((await workspaceFileHistory(left, "note.txt")).some((item) => item.content === "左\n")).toBe(true);
    expect((await workspaceFileHistory(right, "note.txt")).some((item) => item.content === "右\n")).toBe(true);
    expect((await workspaceFileHistory(left, "note.txt")).some((item) => item.content === "右\n")).toBe(false);

    await saveSettings({ workspaceRoot: left, runtime: "pig" });
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const turn = trackWorkspaceTurn(left, async () => { started(); await held; });
    await active;
    const blocked = await app.request("/api/workspace/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "note.txt", content: "占用中\n", baseRevision: workspaceFileRevision("左新\n") }),
    });
    expect(blocked.status).toBe(409);
    expect(await (await app.request("/api/workspace/file?path=note.txt")).json()).toMatchObject({ content: "左新\n" });
    release();
    await turn;
  });
});

it("保存到会话绑定的工作区，不改默认工作区同名文件", async () => {
  const { readFile } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "pig-default-"));
  const bound = await mkdtemp(join(tmpdir(), "pig-bound-"));
  await saveSettings({ workspaceRoot: base, runtime: "pig" });
  await writeFile(join(base, "note.txt"), "original");
  await writeFile(join(bound, "note.txt"), "original");
  const session = await createSession();
  session.workspaceRoot = bound;
  session.executionTarget = "local";
  await saveSession(session);
  const app = createApp();
  const response = await app.request(`/api/workspace/file?sessionId=${session.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({path:"note.txt",content:"edited",baseRevision:workspaceFileRevision("original")}),
  });
  expect(response.status).toBe(200);
  expect(await readFile(join(bound,"note.txt"),"utf8")).toBe("edited");
  expect(await readFile(join(base,"note.txt"),"utf8")).toBe("original");
});
it("远端会话不能经本机保存接口写默认目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "pig-remote-edit-"));
  await saveSettings({workspaceRoot:root});
  await writeFile(join(root,"note.txt"),"original");
  const session=await createSession();session.executionTarget="remote";await saveSession(session);
  const response=await createApp().request(`/api/workspace/file?sessionId=${session.id}`,{
    method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({path:"note.txt",content:"bad",baseRevision:workspaceFileRevision("original")}),
  });
  expect(response.status).toBe(409);
  const {readFile}=await import("node:fs/promises");
  expect(await readFile(join(root,"note.txt"),"utf8")).toBe("original");
});
