import type {
  AgentEvent,
  Session,
  SessionSummary,
  Settings,
  SkillMeta,
  WorkspaceNode,
} from "../types";

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

  createSession: () =>
    fetch("/api/sessions", { method: "POST" }).then((r) => json<Session>(r)),

  deleteSession: (id: string) =>
    fetch(`/api/sessions/${id}`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),

  abort: (id: string) =>
    fetch(`/api/sessions/${id}/abort`, { method: "POST" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  tree: () =>
    fetch("/api/workspace/tree").then((r) =>
      json<{ root: string; tree: WorkspaceNode }>(r),
    ),

  file: (path: string) =>
    fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; content: string; binary: boolean; size: number }>(r),
    ),
};

export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: AgentEvent) => void,
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (block: string) => {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    try {
      onEvent(JSON.parse(dataLines.join("\n")) as AgentEvent);
    } catch {
      // ignore malformed chunks
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) flush(part);
  }
  if (buffer.trim()) flush(buffer);
}
