import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type {
  InboxItem,
  Project,
  ProjectAsset,
  ProjectInvite,
  ProjectInviteStatus,
  ProjectMember,
  ProjectMessage,
  ProjectSummary,
  ProjectTodo,
  TodoStatus,
} from "../types.ts";
import { LOCAL_USER_ID, LOCAL_USER_NAME } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import {
  addInboxItem,
  getInboxItem,
  syncInboxInviteStatus,
} from "./inbox.ts";
import { listSessions } from "./sessions.ts";

export class ProjectInviteError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ProjectInviteError";
    this.status = status;
  }
}

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
    invites: [],
    todos: [],
    assets: [],
    messages: [],
    inviteToken: newId("inv"),
  };
}

function normalizeInvite(raw: ProjectInvite): ProjectInvite {
  return {
    ...raw,
    displayName: raw.displayName?.trim() || "协作成员",
    note: raw.note?.trim() || undefined,
    invitedByUserId: raw.invitedByUserId || LOCAL_USER_ID,
    invitedByName: raw.invitedByName || LOCAL_USER_NAME,
    status: raw.status ?? "pending",
  };
}

function normalizeProject(raw: Project): Project {
  return {
    ...raw,
    instruction: raw.instruction ?? "",
    members: raw.members ?? [],
    invites: (raw.invites ?? []).map(normalizeInvite),
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

export async function listProjectRecords(): Promise<Project[]> {
  ensureDir(DIR);
  const ids = (await readdir(DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const out: Project[] = [];
  for (const id of ids) {
    const project = await readProjectFile(id);
    if (project) out.push(project);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const [projects, sessions] = await Promise.all([listProjectRecords(), listSessions()]);
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    instruction: project.instruction,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    memberCount: project.members.length,
    todoCount: project.todos.length,
    assetCount: project.assets.length,
    sessionCount: sessions.filter((s) => s.projectId === project.id).length,
  }));
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
  const result = await upsertAsset(id, input);
  return result ? { project: result.project, asset: result.asset } : null;
}

export type UpsertAssetInput = {
  filename: string;
  content: Buffer;
  mimeType?: string;
  sourceSessionId?: string;
  sourceArtifactPath?: string;
};

/**
 * Copy bytes into the project assets store.
 * When `sourceArtifactPath` is set, the same workspace path overwrites the
 * existing asset (same id) — idempotent re-save / daily automation.
 * Distinct paths that share a basename get a versioned filename (`a-2.md`).
 */
export async function upsertAsset(
  id: string,
  input: UpsertAssetInput,
): Promise<{ project: Project; asset: ProjectAsset; overwritten: boolean } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const desired = sanitizeAssetFilename(input.filename);
  const ts = nowIso();
  const sourcePath = input.sourceArtifactPath?.trim().replace(/\\/g, "/") || undefined;
  const sourceSessionId = input.sourceSessionId?.trim() || undefined;

  let asset = sourcePath
    ? project.assets.find((a) => a.sourceArtifactPath === sourcePath)
    : undefined;
  const overwritten = Boolean(asset);

  if (asset) {
    asset.size = input.content.length;
    asset.mimeType = input.mimeType || asset.mimeType || "application/octet-stream";
    asset.updatedAt = ts;
    if (sourceSessionId) asset.sourceSessionId = sourceSessionId;
    asset.sourceArtifactPath = sourcePath;
  } else {
    const filename = uniqueAssetFilename(
      project.assets.map((a) => a.filename),
      desired,
    );
    asset = {
      id: newId("ast"),
      filename,
      size: input.content.length,
      mimeType: input.mimeType || "application/octet-stream",
      createdAt: ts,
      sourceSessionId,
      sourceArtifactPath: sourcePath,
    };
    project.assets.push(asset);
  }

  const dir = assetsDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${asset.id}_${asset.filename}`), input.content);
  await activity(
    project,
    overwritten
      ? `更新了资产 ${asset.filename}（来自产物 ${sourcePath ?? asset.filename}）`
      : sourcePath
        ? `从会话产物保存了资产 ${asset.filename}（${sourcePath}）`
        : `上传了资产 ${asset.filename}`,
    { sessionId: sourceSessionId },
  );
  await writeProject(project);
  return { project, asset, overwritten };
}

export function uniqueAssetFilename(existing: string[], desired: string): string {
  if (!existing.includes(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let n = 2;
  while (existing.includes(`${stem}-${n}${ext}`)) n += 1;
  return `${stem}-${n}${ext}`;
}

export function assetDiskPath(projectId: string, asset: ProjectAsset): string {
  return join(assetsDir(projectId), `${asset.id}_${asset.filename}`);
}

export function formatInviteInboxBody(input: {
  inviterName: string;
  inviteeName: string;
  projectName: string;
  note?: string;
  token: string;
}): string {
  const lines = [`${input.inviterName} 邀请 ${input.inviteeName} 加入「${input.projectName}」`];
  if (input.note) lines.push(input.note);
  lines.push(`令牌：${input.token}`);
  return lines.join("\n");
}

function sameDisplayName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findMemberByName(project: Project, displayName: string): ProjectMember | undefined {
  return project.members.find((m) => sameDisplayName(m.displayName, displayName));
}

function findInvite(
  project: Project,
  input: { inviteId?: string; token?: string },
): ProjectInvite | undefined {
  const inviteId = input.inviteId?.trim();
  const token = input.token?.trim();
  if (inviteId) {
    const byId = project.invites.find((i) => i.id === inviteId);
    if (byId) return byId;
  }
  if (token) {
    return project.invites.find((i) => i.token === token);
  }
  return undefined;
}

function ensureInvite(
  project: Project,
  input: { inviteId?: string; token?: string },
): ProjectInvite {
  const existing = findInvite(project, input);
  if (existing) return existing;
  const token = input.token?.trim();
  if (token && project.inviteToken === token) {
    const synthesized: ProjectInvite = {
      id: newId("pinv"),
      token,
      displayName: "协作成员",
      invitedByUserId: LOCAL_USER_ID,
      invitedByName: LOCAL_USER_NAME,
      status: "pending",
      createdAt: nowIso(),
    };
    project.invites.push(synthesized);
    return synthesized;
  }
  throw new ProjectInviteError("Invite not found", 404);
}

function addMemberFromInvite(project: Project, invite: ProjectInvite): ProjectMember {
  const existing = findMemberByName(project, invite.displayName);
  if (existing) return existing;
  const member: ProjectMember = {
    id: newId("mem"),
    userId: `user_${invite.id}`,
    displayName: invite.displayName,
    role: "member",
    joinedAt: nowIso(),
  };
  project.members.push(member);
  return member;
}

async function markInvite(
  project: Project,
  invite: ProjectInvite,
  status: Exclude<ProjectInviteStatus, "pending">,
  extra: { memberId?: string } = {},
): Promise<void> {
  invite.status = status;
  invite.resolvedAt = nowIso();
  if (extra.memberId) invite.memberId = extra.memberId;
  await syncInboxInviteStatus({
    inviteId: invite.id,
    inviteToken: invite.token,
    status,
    markRead: true,
  });
}

export async function inviteMember(
  id: string,
  input: { displayName?: string; note?: string } | string = {},
): Promise<{
  project: Project;
  invite: ProjectInvite;
  inviteToken: string;
  inboxItem: InboxItem;
} | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const displayName =
    (typeof input === "string" ? input : input.displayName)?.trim() || "协作成员";
  const note = (typeof input === "string" ? undefined : input.note)?.trim() || undefined;
  const token = newId("inv");
  const invite: ProjectInvite = {
    id: newId("pinv"),
    token,
    displayName,
    note,
    invitedByUserId: LOCAL_USER_ID,
    invitedByName: LOCAL_USER_NAME,
    status: "pending",
    createdAt: nowIso(),
  };
  project.invites.push(invite);
  project.inviteToken = token;
  await activity(project, `邀请 ${displayName} 加入项目`);
  await writeProject(project);
  const inboxItem = await addInboxItem({
    kind: "invite",
    projectId: project.id,
    title: `邀请加入「${project.name}」`,
    body: formatInviteInboxBody({
      inviterName: LOCAL_USER_NAME,
      inviteeName: displayName,
      projectName: project.name,
      note,
      token,
    }),
    inviteToken: token,
    inviteId: invite.id,
    inviteStatus: "pending",
    projectName: project.name,
    inviterName: LOCAL_USER_NAME,
    inviteeName: displayName,
    inviteNote: note,
  });
  return { project, invite, inviteToken: token, inboxItem };
}

export async function acceptProjectInvite(
  id: string,
  input: { inviteId?: string; token?: string },
): Promise<{ project: Project; invite: ProjectInvite; member: ProjectMember } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const invite = ensureInvite(project, input);
  if (invite.status === "accepted") {
    const member =
      (invite.memberId ? project.members.find((m) => m.id === invite.memberId) : undefined) ??
      findMemberByName(project, invite.displayName) ??
      addMemberFromInvite(project, invite);
    invite.memberId = member.id;
    await syncInboxInviteStatus({
      inviteId: invite.id,
      inviteToken: invite.token,
      status: "accepted",
      markRead: true,
    });
    await writeProject(project);
    return { project, invite, member };
  }
  if (invite.status !== "pending") {
    throw new ProjectInviteError("Invite is no longer pending");
  }
  const member = addMemberFromInvite(project, invite);
  await markInvite(project, invite, "accepted", { memberId: member.id });
  await activity(project, `${member.displayName} 已加入项目`);
  await writeProject(project);
  return { project, invite, member };
}

export async function declineProjectInvite(
  id: string,
  input: { inviteId?: string; token?: string },
): Promise<{ project: Project; invite: ProjectInvite } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const invite = ensureInvite(project, input);
  if (invite.status === "accepted") {
    throw new ProjectInviteError("Invite already accepted");
  }
  if (invite.status === "pending") {
    await markInvite(project, invite, "declined");
    await activity(project, `已拒绝 ${invite.displayName} 的邀请`);
    await writeProject(project);
  } else {
    await syncInboxInviteStatus({
      inviteId: invite.id,
      inviteToken: invite.token,
      status: invite.status,
      markRead: true,
    });
  }
  return { project, invite };
}

export async function revokeProjectInvite(
  id: string,
  inviteId: string,
): Promise<{ project: Project; invite: ProjectInvite } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const invite = project.invites.find((i) => i.id === inviteId);
  if (!invite) throw new ProjectInviteError("Invite not found", 404);
  if (invite.status === "accepted") {
    throw new ProjectInviteError("Cannot revoke an accepted invite");
  }
  if (invite.status === "pending") {
    await markInvite(project, invite, "revoked");
    await activity(project, `已撤销对 ${invite.displayName} 的邀请`);
    await writeProject(project);
  }
  return { project, invite };
}

export async function removeProjectMember(id: string, memberId: string): Promise<Project | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const member = project.members.find((m) => m.id === memberId);
  if (!member) throw new ProjectInviteError("Member not found", 404);
  if (member.role === "owner") {
    throw new ProjectInviteError("Cannot remove the project owner");
  }
  project.members = project.members.filter((m) => m.id !== memberId);
  await activity(project, `已移除成员 ${member.displayName}`);
  return writeProject(project);
}

export async function acceptInboxInvite(inboxId: string): Promise<{
  item: InboxItem;
  project: Project;
  invite: ProjectInvite;
  member: ProjectMember;
} | null> {
  const item = await getInboxItem(inboxId);
  if (!item) return null;
  if (item.kind !== "invite") {
    throw new ProjectInviteError("Inbox item is not an invite");
  }
  const result = await acceptProjectInvite(item.projectId, {
    inviteId: item.inviteId,
    token: item.inviteToken,
  });
  if (!result) throw new ProjectInviteError("Project not found", 404);
  const updated = (await getInboxItem(inboxId)) ?? { ...item, inviteStatus: "accepted" as const, read: true };
  return { item: updated, ...result };
}

export async function declineInboxInvite(inboxId: string): Promise<{
  item: InboxItem;
  project: Project;
  invite: ProjectInvite;
} | null> {
  const item = await getInboxItem(inboxId);
  if (!item) return null;
  if (item.kind !== "invite") {
    throw new ProjectInviteError("Inbox item is not an invite");
  }
  const result = await declineProjectInvite(item.projectId, {
    inviteId: item.inviteId,
    token: item.inviteToken,
  });
  if (!result) throw new ProjectInviteError("Project not found", 404);
  const updated = (await getInboxItem(inboxId)) ?? { ...item, inviteStatus: "declined" as const, read: true };
  return { item: updated, ...result };
}

export async function createHandoff(
  id: string,
  input: { sessionId: string; note?: string; assetIds?: string[] },
): Promise<{ project: Project; inboxItem: InboxItem } | null> {
  const project = await readProjectFile(id);
  if (!project) return null;
  const note = input.note?.trim() || "请接手继续。";
  const names = (input.assetIds ?? [])
    .map((assetId) => project.assets.find((a) => a.id === assetId)?.filename)
    .filter((n): n is string => Boolean(n));
  const body = names.length > 0 ? `${note}\n\n附带资产：${names.join("、")}` : note;
  await activity(project, `转交会话 ${input.sessionId}：${body}`, {
    kind: "handoff",
    sessionId: input.sessionId,
  });
  await writeProject(project);
  const inboxItem = await addInboxItem({
    kind: "handoff",
    projectId: project.id,
    title: `转交：${project.name}`,
    body,
    projectName: project.name,
    sessionId: input.sessionId,
    assetIds: input.assetIds,
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
