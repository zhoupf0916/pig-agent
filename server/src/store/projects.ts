import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type {
  InboxItem,
  Project,
  ProjectAsset,
  ProjectMember,
  ProjectMessage,
  ProjectSummary,
  ProjectTodo,
  TodoStatus,
} from "../types.ts";
import { LOCAL_USER_ID, LOCAL_USER_NAME } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { addInboxItem } from "./inbox.ts";
import { listSessions } from "./sessions.ts";

const DIR = join(DATA_DIR, "projects");

function projectDir(id: string): string {
  return join(DIR, id);
}

function projectFile(id: string): string {
  return join(projectDir(id), "project.json");
}

function assetsDir(id: string): string {
  return join(projectDir(id), "assets");
}

export function sanitizeAssetFilename(filename: string): string {
  const base = basename(filename).replace(/[/\\]/g, "");
  if (!base || base === "." || base === ".." || base.includes("\0")) {
    throw new Error("Invalid asset filename");
  }
  return base;
}

function emptyProject(name: string, instruction = ""): Project {
  const ts = nowIso();
  const owner: ProjectMember = {
    id: newId("mem"),
    userId: LOCAL_USER_ID,
    displayName: LOCAL_USER_NAME,
    role: "owner",
    joinedAt: ts,
  };
  return {
    id: newId("prj"),
    name: name.trim() || "未命名项目",
    instruction: instruction.trim(),
    createdAt: ts,
    updatedAt: ts,
    members: [owner],
    todos: [],
    assets: [],
    messages: [],
    inviteToken: newId("inv"),
  };
}

function normalizeProject(raw: Project): Project {
  return {
    ...raw,
    instruction: raw.instruction ?? "",
    members: raw.members ?? [],
    todos: raw.todos ?? [],
    assets: raw.assets ?? [],
    messages: raw.messages ?? [],
    inviteToken: raw.inviteToken || newId("inv"),
  };
}

async function writeProject(project: Project): Promise<Project> {
  project.updatedAt = nowIso();
  ensureDir(projectDir(project.id));
  await atomicWriteJson(projectFile(project.id), project);
  return project;
}

async function readProjectFile(id: string): Promise<Project | null> {
  const file = projectFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Project;
    return normalizeProject(raw);
  } catch {
    return null;
  }
}

async function activity(
  project: Project,
  body: string,
  extra: Partial<ProjectMessage> = {},
): Promise<void> {
  project.messages.push({
    id: newId("pmsg"),
    kind: extra.kind ?? "activity",
    body,
    actorId: extra.actorId ?? LOCAL_USER_ID,
    createdAt: nowIso(),
    sessionId: extra.sessionId,
  });
}

export async function createProject(input: {
  name: string;
  instruction?: string;
}): Promise<Project> {
  ensureDir(DIR);
  const project = emptyProject(input.name, input.instruction ?? "");
  await activity(project, `创建了项目「${project.name}」`);
  await writeProject(project);
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  return readProjectFile(id);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  ensureDir(DIR);
  const ids = (await readdir(DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const sessions = await listSessions();
  const out: ProjectSummary[] = [];
  for (const id of ids) {
    const project = await readProjectFile(id);
    if (!project) continue;
    out.push({
      id: project.id,
      name: project.name,
      instruction: project.instruction,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      memberCount: project.members.length,
      todoCount: project.todos.length,
      assetCount: project.assets.length,
      sessionCount: sessions.filter((s) => s.projectId === project.id).length,
    });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function updateProject(
  id: string,
  patch: { name?: string; instruction?: string },
): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  if (typeof patch.name === "string" && patch.name.trim() && patch.name.trim() !== project.name) {
    const next = patch.name.trim();
    await activity(project, `将项目名改为「${next}」`);
    project.name = next;
  }
  if (typeof patch.instruction === "string" && patch.instruction !== project.instruction) {
    project.instruction = patch.instruction;
    await activity(project, "更新了项目指令");
  }
  return writeProject(project);
}

export async function deleteProject(id: string): Promise<boolean> {
  const dir = projectDir(id);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export async function addProjectMessage(
  id: string,
  body: string,
  kind: ProjectMessage["kind"] = "comment",
): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const text = body.trim();
  if (!text) throw new Error("Message body is required");
  await activity(project, text, { kind });
  return writeProject(project);
}

export async function createTodo(
  id: string,
  input: { title: string; status?: TodoStatus; sessionId?: string },
): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const title = input.title.trim();
  if (!title) throw new Error("Todo title is required");
  const ts = nowIso();
  const todo: ProjectTodo = {
    id: newId("todo"),
    title,
    status: input.status ?? "todo",
    sessionId: input.sessionId,
    createdAt: ts,
    updatedAt: ts,
  };
  project.todos.push(todo);
  await activity(project, `新增待办「${title}」`);
  return writeProject(project);
}

export async function updateTodo(
  id: string,
  todoId: string,
  patch: { title?: string; status?: TodoStatus; sessionId?: string | null },
): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const todo = project.todos.find((t) => t.id === todoId);
  if (!todo) return null;
  if (typeof patch.title === "string" && patch.title.trim()) todo.title = patch.title.trim();
  if (patch.status) todo.status = patch.status;
  if (patch.sessionId === null) delete todo.sessionId;
  else if (typeof patch.sessionId === "string") todo.sessionId = patch.sessionId;
  todo.updatedAt = nowIso();
  await activity(project, `更新待办「${todo.title}」→ ${todo.status}`);
  return writeProject(project);
}

export async function deleteTodo(id: string, todoId: string): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const prev = project.todos.find((t) => t.id === todoId);
  project.todos = project.todos.filter((t) => t.id !== todoId);
  if (prev) await activity(project, `删除待办「${prev.title}」`);
  return writeProject(project);
}

export async function addAsset(
  id: string,
  input: { filename: string; content: Buffer; mimeType?: string },
): Promise<{ project: Project; asset: ProjectAsset } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const filename = sanitizeAssetFilename(input.filename);
  const asset: ProjectAsset = {
    id: newId("ast"),
    filename,
    size: input.content.length,
    mimeType: input.mimeType || "application/octet-stream",
    createdAt: nowIso(),
  };
  const dir = assetsDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${asset.id}_${filename}`), input.content);
  project.assets.push(asset);
  await activity(project, `上传了资产 ${filename}`);
  await writeProject(project);
  return { project, asset };
}

export function assetDiskPath(projectId: string, asset: ProjectAsset): string {
  return join(assetsDir(projectId), `${asset.id}_${asset.filename}`);
}

export async function inviteMember(id: string, displayName?: string): Promise<{
  project: Project;
  inviteToken: string;
  inboxItem: InboxItem;
} | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  project.inviteToken = newId("inv");
  const label = displayName?.trim() || "协作成员";
  await activity(project, `生成了邀请令牌（给 ${label}）`);
  await writeProject(project);
  const inboxItem = await addInboxItem({
    kind: "invite",
    projectId: project.id,
    title: `邀请加入「${project.name}」`,
    body: `本机单用户占位邀请。令牌：${project.inviteToken}`,
    inviteToken: project.inviteToken,
  });
  return { project, inviteToken: project.inviteToken, inboxItem };
}

export async function createHandoff(
  id: string,
  input: { sessionId: string; note?: string },
): Promise<{ project: Project; inboxItem: InboxItem } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const note = input.note?.trim() || "请接手继续。";
  await activity(project, `转交会话 ${input.sessionId}：${note}`, {
    kind: "handoff",
    sessionId: input.sessionId,
  });
  await writeProject(project);
  const inboxItem = await addInboxItem({
    kind: "handoff",
    projectId: project.id,
    title: `转交：${project.name}`,
    body: note,
    sessionId: input.sessionId,
  });
  return { project, inboxItem };
}

export async function resolveProjectInstruction(
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) return undefined;
  const project = await readProjectFile(projectId);
  const text = project?.instruction.trim();
  return text || undefined;
}

export async function recordSessionBound(projectId: string, sessionId: string): Promise<void> {
  const project = await readProjectFile(projectId);
  if (!project) return;
  await activity(project, `会话 ${sessionId} 已绑定到本项目`, { sessionId });
  await writeProject(project);
}
