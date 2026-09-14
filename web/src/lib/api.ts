import type {
  AgentEvent,
  AgentRuntime,
  Automation,
  Expert,
  ExpertKind,
  ExpertTeam,
  ExpertTeamMode,
  AssetPreview,
  InboxItem,
  MemoryKind,
  MemoryNote,
  Project,
  ProjectAsset,
  ProjectInvite,
  ProjectMember,
  ProjectSummary,
  SearchResponse,
  Session,
  SessionSummary,
  Settings,
  SkillMeta,
  TodoStatus,
  WorkspaceNode,
} from "../types";
import { sessionEventsSubscribeInit } from "./transcript-sync";

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    return JSON.stringify(body.error ?? res.statusText);
  } catch {
    return res.statusText;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as T;
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<{ ok: boolean }>(r)),

  settings: () => fetch("/api/settings").then((r) => json<Settings>(r)),

  saveSettings: (patch: Partial<Settings>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Settings>(r)),

  skills: () =>
    fetch("/api/skills").then((r) => json<{ skills: SkillMeta[] }>(r)),

  sessions: () =>
    fetch("/api/sessions").then((r) => json<{ sessions: SessionSummary[] }>(r)),

  session: (id: string) => fetch(`/api/sessions/${id}`).then((r) => json<Session>(r)),

  createSession: (input?: { projectId?: string; expertId?: string; expertTeamId?: string } | string) => {
    const body =
      typeof input === "string"
        ? { projectId: input }
        : {
            ...(input?.projectId ? { projectId: input.projectId } : {}),
            ...(input?.expertId ? { expertId: input.expertId } : {}),
            ...(input?.expertTeamId ? { expertTeamId: input.expertTeamId } : {}),
          };
    return fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Session>(r));
  },

  patchSession: (
    id: string,
    patch: {
      projectId?: string | null;
      expertId?: string | null;
      expertTeamId?: string | null;
      title?: string;
    },
  ) =>
    fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Session>(r)),

  deleteSession: (id: string) =>
    fetch(`/api/sessions/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  abort: (id: string) =>
    fetch(`/api/sessions/${id}/abort`, { method: "POST" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  stopTeamRun: (id: string) =>
    fetch(`/api/sessions/${id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).then((r) => json<{ ok: boolean; running: boolean; session: Session }>(r)),

  projects: () =>
    fetch("/api/projects").then((r) => json<{ projects: ProjectSummary[] }>(r)),

  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<Project>(r)),

  createProject: (input: { name: string; instruction?: string }) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<Project>(r)),

  patchProject: (id: string, patch: { name?: string; instruction?: string }) =>
    fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Project>(r)),

  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  createTodo: (projectId: string, input: { title: string; status?: TodoStatus }) =>
    fetch(`/api/projects/${projectId}/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ todos: Project["todos"] }>(r)),

  patchTodo: (projectId: string, todoId: string, patch: { title?: string; status?: TodoStatus }) =>
    fetch(`/api/projects/${projectId}/todos/${todoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ todos: Project["todos"] }>(r)),

  deleteTodo: (projectId: string, todoId: string) =>
    fetch(`/api/projects/${projectId}/todos/${todoId}`, { method: "DELETE" }).then((r) =>
      json<{ todos: Project["todos"] }>(r),
    ),

  uploadAsset: (
    projectId: string,
    input: { filename: string; content?: string; contentBase64?: string; mimeType?: string },
  ) =>
    fetch(`/api/projects/${projectId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ assets: Project["assets"] }>(r)),

  assetPreview: (projectId: string, assetId: string) =>
    fetch(`/api/projects/${projectId}/assets/${assetId}`).then((r) => json<AssetPreview>(r)),

  assetDownloadUrl: (projectId: string, assetId: string, inline = false) =>
    `/api/projects/${projectId}/assets/${assetId}/download${inline ? "?inline=1" : ""}`,

  createHandoff: (
    projectId: string,
    input: {
      sessionId: string;
      note?: string;
      artifactPaths?: string[];
      attachRecentArtifacts?: boolean;
    },
  ) =>
    fetch(`/api/projects/${projectId}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) =>
      json<{
        inboxItem: InboxItem;
        messages: Project["messages"];
        assets: ProjectAsset[];
        attached: Array<{ artifactPath: string; asset: ProjectAsset }>;
        skipped: Array<{ artifactPath: string; reason: string }>;
      }>(r),
    ),

  postProjectMessage: (projectId: string, body: string) =>
    fetch(`/api/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }).then((r) => json<{ messages: Project["messages"] }>(r)),

  inviteMember: (projectId: string, input: { displayName?: string; note?: string } = {}) =>
    fetch(`/api/projects/${projectId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) =>
      json<{
        inviteToken: string;
        invite: ProjectInvite;
        members: ProjectMember[];
        invites: ProjectInvite[];
        inboxItem: InboxItem;
      }>(r),
    ),

  redeemInvite: (projectId: string, token: string) =>
    fetch(`/api/projects/${projectId}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then((r) => json<{ project: Project; invite: ProjectInvite; member: ProjectMember }>(r)),

  revokeInvite: (projectId: string, inviteId: string) =>
    fetch(`/api/projects/${projectId}/invites/${inviteId}`, { method: "DELETE" }).then((r) =>
      json<{ invite: ProjectInvite; members: ProjectMember[]; invites: ProjectInvite[] }>(r),
    ),

  removeMember: (projectId: string, memberId: string) =>
    fetch(`/api/projects/${projectId}/members/${memberId}`, { method: "DELETE" }).then((r) =>
      json<{ members: ProjectMember[] }>(r),
    ),

  inbox: () =>
    fetch("/api/inbox").then((r) => json<{ items: InboxItem[]; unread: number }>(r)),

  markInboxRead: (id: string) =>
    fetch(`/api/inbox/${id}/read`, { method: "POST" }).then((r) => json<InboxItem>(r)),

  acceptInboxInvite: (id: string) =>
    fetch(`/api/inbox/${id}/accept`, { method: "POST" }).then((r) =>
      json<{ item: InboxItem; project: Project; invite: ProjectInvite; member: ProjectMember }>(r),
    ),

  declineInboxInvite: (id: string) =>
    fetch(`/api/inbox/${id}/decline`, { method: "POST" }).then((r) =>
      json<{ item: InboxItem; project: Project; invite: ProjectInvite }>(r),
    ),

  experts: () => fetch("/api/experts").then((r) => json<{ experts: Expert[] }>(r)),

  expert: (id: string) => fetch(`/api/experts/${id}`).then((r) => json<Expert>(r)),

  createExpert: (input: {
    name: string;
    description?: string;
    instruction: string;
    kind?: ExpertKind;
    skillIds?: string[];
  }) =>
    fetch("/api/experts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<Expert>(r)),

  patchExpert: (
    id: string,
    patch: {
      name?: string;
      description?: string;
      instruction?: string;
      kind?: ExpertKind;
      skillIds?: string[];
    },
  ) =>
    fetch(`/api/experts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Expert>(r)),

  deleteExpert: (id: string) =>
    fetch(`/api/experts/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  expertTeams: () => fetch("/api/expert-teams").then((r) => json<{ teams: ExpertTeam[] }>(r)),

  createExpertTeam: (input: {
    name: string;
    description?: string;
    mode?: ExpertTeamMode;
    expertIds: string[];
  }) =>
    fetch("/api/expert-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<ExpertTeam>(r)),

  automations: () => fetch("/api/automations").then((r) => json<{ automations: Automation[] }>(r)),

  automation: (id: string) => fetch(`/api/automations/${id}`).then((r) => json<Automation>(r)),

  createAutomation: (input: {
    name: string;
    prompt: string;
    enabled?: boolean;
    schedule?: string | null;
    expertId?: string;
    expertTeamId?: string;
    projectId?: string;
    runtime?: AgentRuntime;
    saveArtifactsToProject?: boolean;
  }) =>
    fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<Automation>(r)),

  patchAutomation: (
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      enabled?: boolean;
      schedule?: string | null;
      expertId?: string | null;
      expertTeamId?: string | null;
      projectId?: string | null;
      runtime?: AgentRuntime;
      saveArtifactsToProject?: boolean;
    },
  ) =>
    fetch(`/api/automations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Automation>(r)),

  deleteAutomation: (id: string) =>
    fetch(`/api/automations/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  runAutomation: (id: string) =>
    fetch(`/api/automations/${id}/run`, { method: "POST" }).then((r) =>
      json<{ automation: Automation; session: Session }>(r),
    ),

  saveArtifactToProject: (sessionId: string, name: string) =>
    fetch(
      `/api/sessions/${sessionId}/artifacts/${encodeURIComponent(name)}/save-to-project`,
      { method: "POST" },
    ).then((r) =>
      json<{ projectId: string; artifactPath: string; asset: ProjectAsset; overwritten: boolean }>(r),
    ),

  saveAllArtifactsToProject: (sessionId: string, paths?: string[]) =>
    fetch(`/api/sessions/${sessionId}/artifacts/save-all-to-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paths ? { paths } : {}),
    }).then((r) =>
      json<{
        projectId: string;
        saved: Array<{ artifactPath: string; asset: ProjectAsset; overwritten: boolean }>;
        skipped: Array<{ artifactPath: string; reason: string }>;
      }>(r),
    ),

  memory: (filter?: { kind?: MemoryKind; sessionId?: string; projectId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filter?.kind) params.set("kind", filter.kind);
    if (filter?.sessionId) params.set("sessionId", filter.sessionId);
    if (filter?.projectId) params.set("projectId", filter.projectId);
    if (typeof filter?.limit === "number") params.set("limit", String(filter.limit));
    const qs = params.toString();
    return fetch(`/api/memory${qs ? `?${qs}` : ""}`).then((r) => json<{ notes: MemoryNote[] }>(r));
  },

  memoryNote: (id: string) => fetch(`/api/memory/${id}`).then((r) => json<MemoryNote>(r)),

  createMemory: (input: {
    kind?: MemoryKind;
    text: string;
    tags?: string[];
    sessionId?: string;
    projectId?: string;
  }) =>
    fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<MemoryNote>(r)),

  patchMemory: (
    id: string,
    patch: {
      kind?: MemoryKind;
      text?: string;
      tags?: string[] | null;
      sessionId?: string | null;
      projectId?: string | null;
    },
  ) =>
    fetch(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<MemoryNote>(r)),

  deleteMemory: (id: string) =>
    fetch(`/api/memory/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  sessionRecap: (sessionId: string) =>
    fetch(`/api/sessions/${sessionId}/recap`, { method: "POST" }).then((r) => json<MemoryNote>(r)),

  search: (q: string, limit?: number) => {
    const params = new URLSearchParams({ q });
    if (typeof limit === "number") params.set("limit", String(limit));
    return fetch(`/api/search?${params}`).then((r) => json<SearchResponse>(r));
  },

  tree: () =>
    fetch("/api/workspace/tree").then((r) =>
      json<{ root: string; tree: WorkspaceNode }>(r),
    ),

  file: (path: string) =>
    fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; content: string; binary: boolean; size: number }>(r),
    ),
};

function parseSseBlock(
  block: string,
  onEvent: (event: AgentEvent, seq?: number) => void,
): void {
  let seq: number | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) seq = n;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return;
  try {
    onEvent(JSON.parse(dataLines.join("\n")) as AgentEvent, seq);
  } catch {
    // ignore malformed chunks
  }
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent, seq?: number) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) parseSseBlock(part, onEvent);
  }
  if (buffer.trim()) parseSseBlock(buffer, onEvent);
}

export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: AgentEvent, seq?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await parseError(res));
  }
  await readSseStream(res.body, onEvent);
}

/** Re-run the last user turn (pig/codex 重试本轮, or remote follow-up / create-run). Does not add a message. */
export async function streamRetry(
  sessionId: string,
  onEvent: (event: AgentEvent, seq?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await parseError(res));
  }
  await readSseStream(res.body, onEvent);
}

export async function streamTeamRun(
  sessionId: string,
  input: { action: "start" | "continue"; content?: string },
  onEvent: (event: AgentEvent, seq?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/team-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await parseError(res));
  }
  await readSseStream(res.body, onEvent);
}

export async function subscribeSessionEvents(
  sessionId: string,
  after: number,
  onEvent: (event: AgentEvent, seq?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { query, headers } = sessionEventsSubscribeInit(after);
  const res = await fetch(`/api/sessions/${sessionId}/events?${query}`, {
    headers,
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await parseError(res));
  }
  await readSseStream(res.body, onEvent);
}
