import type { AgentEvent, ChatMessage, Session, Settings } from "../../types.ts";
import { newId, nowIso } from "../../util.ts";
import { deliverableSummary } from "../runtime.ts";
import {
  CLOUD_ABORT_PATH,
  CLOUD_CREATE_RUN_PATH,
  CLOUD_EVENTS_PATH,
  CLOUD_FOLLOW_UP_PATH,
} from "./contract.ts";
import { resolveEffectiveCloudBaseUrl } from "./env-json.ts";
import {
  DEFAULT_CLOUD_CONTROL_TIMEOUT_MS,
  cloudRemoteError,
  decideRemoteRetry,
  formatCloudRemoteError,
  isCloudTimeoutError,
  isExpiredHttpStatus,
  isUserAbort,
  redactCloudErrorDetail,
} from "./errors.ts";
import { CreateRunProgress } from "./create-run-progress.ts";
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
  timeoutMs?: number;
}): Promise<Session> {
  const { settings, signal, emit } = options;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOUD_CONTROL_TIMEOUT_MS;
  const keepRunId = options.session.remoteRunId;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    remoteRetry: undefined,
    updatedAt: nowIso(),
    remoteRunId: keepRunId,
  };
  emit({ type: "status", status: "running" });

  const resolved = resolveEffectiveCloudBaseUrl(settings).replace(/\/+$/, "");
  if (!resolved) {
    throw cloudRemoteError("missing_url");
  }
  const base = resolved;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (settings.cloudToken.trim()) {
    headers.authorization = `Bearer ${settings.cloudToken.trim()}`;
  }

  let runId = session.remoteRunId?.trim() ?? "";
  let eventsHold: Response | undefined;
  const progress = new CreateRunProgress(session, emit);

  try {
    if (runId) {
      const follow = await postFollowUp(
        fetchFn,
        base,
        runId,
        session,
        settings,
        headers,
        signal,
        timeoutMs,
      );
      if (follow !== "ok") {
        runId = "";
        delete session.remoteRunId;
      }
    }

    if (!runId) {
      progress.begin("snapshot");
      const workspace = buildRemoteWorkspaceHandoff(settings);
      const body = buildCreateRunRequest(session, settings, workspace, {
        expertInstruction: options.expertInstruction,
        projectInstruction: options.projectInstruction,
      });
      assertNoSecretsInPayload(body, settings);
      progress.begin("create");
      const created = await fetchUntilHeaders(
        fetchFn,
        `${base}${CLOUD_CREATE_RUN_PATH}`,
        { method: "POST", headers, body: JSON.stringify(body) },
        signal,
        timeoutMs,
      );
      if (!created.ok) {
        const text = await created.text().catch(() => "");
        throw cloudRemoteError(
          "create_run_failed",
          `（HTTP ${created.status}）${text ? redactCloudErrorDetail(text.slice(0, 240)) : ""}`,
        );
      }
      runId = readRunId(await created.json());
      if (!runId) throw cloudRemoteError("no_run_id");
      progress.begin("subscribe");
    }

    session.remoteRunId = runId;

    const eventsRes = (eventsHold = await fetchUntilHeaders(
      fetchFn,
      `${base}${CLOUD_EVENTS_PATH(runId)}`,
      {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(settings.cloudToken.trim()
            ? { authorization: `Bearer ${settings.cloudToken.trim()}` }
            : {}),
        },
      },
      signal,
      timeoutMs,
      { holdUserAbort: true },
    ));
    if (!eventsRes.ok || !eventsRes.body) {
      releaseHeldUserAbort(eventsRes);
      if (isExpiredHttpStatus(eventsRes.status)) {
        delete session.remoteRunId;
        runId = "";
        throw cloudRemoteError("run_expired");
      }
      throw cloudRemoteError("subscribe_failed", `（HTTP ${eventsRes.status}）`);
    }

    try {
      let handedOff = false;
      for await (const raw of readSseJson(eventsRes, signal)) {
        for (const event of mapCloudEvent(raw)) {
          const mapped =
            event.type === "error"
              ? { ...event, message: formatCloudRemoteError(event.message) }
              : event;
          if (!handedOff) {
            progress.handoffToStream();
            handedOff = true;
          }
          applyRemoteEvent(session, mapped);
          // Host emits a single `done` after the stream so the UI always gets
          // the accumulated pig session, not a remote-shaped snapshot.
          if (mapped.type !== "done") emit(mapped);
        }
      }
    } finally {
      releaseHeldUserAbort(eventsRes);
    }

    if (signal.aborted) throw new Error("Aborted");
    if (session.status === "error") {
      session.lastError = formatCloudRemoteError(session.lastError ?? "云端远程执行失败。");
      session.remoteRetry = decideRemoteRetry(session.lastError, session.remoteRunId);
      if (session.remoteRetry === "create-run") delete session.remoteRunId;
      session.updatedAt = nowIso();
      emit({ type: "done", session });
      return session;
    }
    if (session.status === "running") {
      throw cloudRemoteError("disconnected");
    }
    session.remoteRetry = undefined;
    session.updatedAt = nowIso();
    emit({ type: "done", session });
    return session;
  } catch (err) {
    releaseHeldUserAbort(eventsHold);
    const aborted = isUserAbort(err, signal);
    // Only user abort notifies the plane. Timeout / disconnect keep remoteRunId
    // so 重试 can follow-up instead of killing a still-running worker.
    if (aborted && runId) {
      await abortRemoteRun(fetchFn, base, runId, headers);
    }
    if (aborted) {
      progress.abort();
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
      session.remoteRetry = undefined;
    } else {
      progress.fail();
      const message = formatCloudRemoteError(err);
      session.status = "error";
      session.lastError = message;
      session.remoteRetry = decideRemoteRetry(err, session.remoteRunId ?? runId);
      if (session.remoteRetry === "create-run") {
        delete session.remoteRunId;
      }
      emit({ type: "error", message });
    }
    session.updatedAt = nowIso();
    emit({ type: "status", status: session.status });
    emit({ type: "done", session });
    return session;
  }
}

/**
 * Timeout applies only until response headers arrive so SSE bodies can run longer
 * than the control-plane connect budget. `holdUserAbort` keeps the user signal
 * linked after headers so 停止 cancels the SSE body (no zombie running turn).
 */
async function fetchUntilHeaders(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  userSignal: AbortSignal,
  timeoutMs: number,
  options: { holdUserAbort?: boolean } = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const onUserAbort = () => ctrl.abort(userSignal.reason);
  if (userSignal.aborted) throw new Error("Aborted");
  userSignal.addEventListener("abort", onUserAbort);
  const timer = setTimeout(() => ctrl.abort("cloud-timeout"), timeoutMs);
  const unlink = () => userSignal.removeEventListener("abort", onUserAbort);
  try {
    const response = await fetchFn(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    if (options.holdUserAbort) {
      heldUserAborts.set(response, unlink);
    } else {
      unlink();
    }
    return response;
  } catch (err) {
    clearTimeout(timer);
    unlink();
    if (isUserAbort(err, userSignal)) throw new Error("Aborted");
    if (ctrl.signal.aborted && !userSignal.aborted) {
      throw cloudRemoteError("control_plane_timeout");
    }
    if (isCloudTimeoutError(err, userSignal)) throw cloudRemoteError("control_plane_timeout");
    throw err;
  }
}

const heldUserAborts = new WeakMap<Response, () => void>();

function releaseHeldUserAbort(response?: Response): void {
  if (!response) return;
  heldUserAborts.get(response)?.();
  heldUserAborts.delete(response);
}

async function postFollowUp(
  fetchFn: typeof fetch,
  base: string,
  runId: string,
  session: Session,
  settings: Settings,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<"ok" | "expired"> {
  const body = buildFollowUpRequest(session);
  assertNoSecretsInPayload(body, settings);
  try {
    const res = await fetchUntilHeaders(
      fetchFn,
      `${base}${CLOUD_FOLLOW_UP_PATH(runId)}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      signal,
      timeoutMs,
    );
    if (res.ok) return "ok";
    return "expired";
  } catch (err) {
    if (isUserAbort(err, signal)) {
      throw err instanceof Error ? err : new Error("Aborted");
    }
    if (err && typeof err === "object" && "code" in err && err.code === "control_plane_timeout") {
      throw err;
    }
    if (isCloudTimeoutError(err, signal)) throw cloudRemoteError("control_plane_timeout");
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
  let rejectAbort: ((err: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => undefined);
  const onAbort = () => {
    rejectAbort?.(new Error("Aborted"));
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
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
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // cancel() may already have released the lock
    }
  }
}
