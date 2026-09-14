import type { AgentEvent, ChatMessage, Session, Settings } from "../../types.ts";
import { newId, nowIso } from "../../util.ts";
import { deliverableSummary } from "../runtime.ts";
import {
  CLOUD_ABORT_PATH,
  CLOUD_CREATE_RUN_PATH,
  CLOUD_EVENTS_PATH,
  CLOUD_FOLLOW_UP_PATH,
  CloudRuntimeError,
} from "./contract.ts";
import { mapCloudEvent } from "./events.ts";
import {
  assertNoSecretsInPayload,
  buildCreateRunRequest,
  buildFollowUpRequest,
  buildRemoteWorkspaceHandoff,
} from "./request.ts";

export async function runRemoteCloudAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  fetchImpl?: typeof fetch;
  projectInstruction?: string;
  expertInstruction?: string;
}): Promise<Session> {
  const { settings, signal, emit } = options;
  const fetchFn = options.fetchImpl ?? fetch;
  const keepRunId = options.session.remoteRunId;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    updatedAt: nowIso(),
    remoteRunId: keepRunId,
  };
  emit({ type: "status", status: "running" });

  const base = settings.cloudBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (settings.cloudToken.trim()) {
    headers.authorization = `Bearer ${settings.cloudToken.trim()}`;
  }

  let runId = session.remoteRunId?.trim() ?? "";

  try {
    if (runId) {
      const follow = await postFollowUp(fetchFn, base, runId, session, settings, headers, signal);
      if (follow !== "ok") {
        runId = "";
        delete session.remoteRunId;
      }
    }

    if (!runId) {
      const workspace = buildRemoteWorkspaceHandoff(settings);
      const body = buildCreateRunRequest(session, settings, workspace, {
        expertInstruction: options.expertInstruction,
        projectInstruction: options.projectInstruction,
      });
      assertNoSecretsInPayload(body, settings);
      const created = await fetchFn(`${base}${CLOUD_CREATE_RUN_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!created.ok) {
        const text = await created.text().catch(() => "");
        throw new CloudRuntimeError(
          `Create run failed (${created.status})${text ? `: ${text.slice(0, 240)}` : ""}`,
        );
      }
      runId = readRunId(await created.json());
      if (!runId) throw new CloudRuntimeError("Control plane did not return a run id");
    }

    session.remoteRunId = runId;

    const eventsRes = await fetchFn(`${base}${CLOUD_EVENTS_PATH(runId)}`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(settings.cloudToken.trim()
          ? { authorization: `Bearer ${settings.cloudToken.trim()}` }
          : {}),
      },
      signal,
    });
    if (!eventsRes.ok || !eventsRes.body) {
      throw new CloudRuntimeError(`Subscribe events failed (${eventsRes.status})`);
    }

    for await (const raw of readSseJson(eventsRes, signal)) {
      for (const event of mapCloudEvent(raw)) {
        applyRemoteEvent(session, event);
        // Host emits a single `done` after the stream so the UI always gets
        // the accumulated pig session, not a remote-shaped snapshot.
        if (event.type !== "done") emit(event);
      }
    }

    if (signal.aborted) throw new Error("Aborted");
    if (session.status === "running") {
      session.status = "idle";
      emit({ type: "status", status: "idle" });
    }
    session.updatedAt = nowIso();
    emit({ type: "done", session });
    return session;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = message === "Aborted" || err instanceof DOMException || signal.aborted;
    if (runId) {
      await abortRemoteRun(fetchFn, base, runId, headers);
    }
    if (aborted) {
      const stop: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        content: deliverableSummary(session, "已停止。已完成的步骤和产物仍可在右侧审阅。"),
        createdAt: nowIso(),
      };
      session.messages.push(stop);
      emit({ type: "message", message: stop });
      session.status = "idle";
      session.lastError = undefined;
    } else {
      session.status = "error";
      session.lastError = message;
      emit({ type: "error", message });
    }
    session.updatedAt = nowIso();
    emit({ type: "status", status: session.status });
    emit({ type: "done", session });
    return session;
  }
}

async function postFollowUp(
  fetchFn: typeof fetch,
  base: string,
  runId: string,
  session: Session,
  settings: Settings,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<"ok" | "expired"> {
  const body = buildFollowUpRequest(session);
  assertNoSecretsInPayload(body, settings);
  try {
    const res = await fetchFn(`${base}${CLOUD_FOLLOW_UP_PATH(runId)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return "ok";
    return "expired";
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === "Aborted")) {
      throw err instanceof Error ? err : new Error("Aborted");
    }
    return "expired";
  }
}

async function abortRemoteRun(
  fetchFn: typeof fetch,
  base: string,
  runId: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    await fetchFn(`${base}${CLOUD_ABORT_PATH(runId)}`, {
      method: "POST",
      headers,
      body: "{}",
    });
  } catch {
    // Best-effort: the host AbortSignal already dropped the SSE.
  }
}

function readRunId(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  if (typeof obj.runId === "string") return obj.runId;
  const nested = obj.run;
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return (nested as { id: string }).id;
  }
  return "";
}

function applyRemoteEvent(session: Session, event: AgentEvent): void {
  if (event.type === "message") {
    if (!session.messages.some((m) => m.id === event.message.id)) {
      session.messages.push(event.message);
    }
    return;
  }
  if (event.type === "tool_start") {
    if (session.messages.some((m) => m.toolCalls?.some((c) => c.id === event.id))) return;
    session.messages.push({
      id: newId("msg"),
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: event.id,
          name: event.name,
          arguments: stringifyArgs(event.arguments),
        },
      ],
      createdAt: event.startedAt || nowIso(),
    });
    return;
  }
  if (event.type === "tool_end") {
    if (session.messages.some((m) => m.role === "tool" && m.toolCallId === event.id)) return;
    session.messages.push({
      id: newId("msg"),
      role: "tool",
      content: event.output,
      toolCallId: event.id,
      toolOk: event.ok,
      toolDurationMs: event.durationMs,
      createdAt: nowIso(),
    });
    return;
  }
  if (event.type === "steps") {
    session.steps = event.steps;
    return;
  }
  if (event.type === "step") {
    session.steps = [...session.steps.filter((s) => s.id !== event.step.id), event.step];
    return;
  }
  if (event.type === "artifact") {
    session.artifacts = [
      ...session.artifacts.filter((a) => a.path !== event.artifact.path),
      event.artifact,
    ];
    return;
  }
  if (event.type === "status") {
    session.status = event.status;
    return;
  }
  if (event.type === "error") {
    session.lastError = event.message;
    session.status = "error";
    return;
  }
  if (event.type === "done") {
    const keep = session.remoteRunId;
    session.status = event.session.status;
    session.messages = event.session.messages;
    session.steps = event.session.steps;
    session.artifacts = event.session.artifacts;
    session.lastError = event.session.lastError;
    session.remoteRunId = keep ?? event.session.remoteRunId;
  }
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

async function* readSseJson(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as unknown;
        } catch {
          // ignore malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
