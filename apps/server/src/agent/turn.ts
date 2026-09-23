import { reconcileRemoteSession } from "../control-plane/run-state.ts";
import { resolveExpertPlaybook } from "../store/experts.ts";
import { publishPersistedEvent } from "../store/events.ts";
import { resolveProjectInstruction } from "../store/projects.ts";
import { saveSession } from "../store/sessions.ts";
import { loadSessionSettings } from "../store/settings.ts";
import { shouldRunSequentialTeam } from "../store/team-run-state.ts";
import type { AgentEvent, AgentRuntime, ChatMessage, Session } from "../types.ts";
import { newId, nowIso, truncate } from "../util.ts";
import { decideRemoteRetry, formatCloudRemoteError } from "./cloud/errors.ts";
import { runCloudAgent } from "./cloud/runtime.ts";
import { runCodexAgent } from "./codex/runtime.ts";
import { decideLocalRetry, formatLocalTurnError } from "./local-errors.ts";
import { prepareSessionMcp } from "../store/mcp-servers.ts";
import { runAgent } from "./runtime.ts";
import { runSequentialTeamTurn } from "./team-run.ts";

export const runningTurns = new Map<string, AbortController>();

export function isTurnActive(sessionId: string): boolean {
  return runningTurns.has(sessionId);
}

/** True when the JSON says running but no in-process turn is registered (zombie). */
export function isStaleRunningSession(session: Session): boolean {
  return session.status === "running" && !runningTurns.has(session.id);
}

export async function releaseStaleRunningSession(session: Session): Promise<boolean> {
  if (!isStaleRunningSession(session)) return false;
  if (session.remoteState && session.remoteRunId) await reconcileRemoteSession(session);
  else session.status = "idle";
  session.updatedAt = nowIso();
  await saveSession(session);
  return true;
}

/** Wait for an aborted turn to leave `runningTurns` so the next send is not 409. */
export async function waitForTurnRelease(
  sessionId: string,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (runningTurns.has(sessionId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return !runningTurns.has(sessionId);
}

export function pickRunner(runtime: AgentRuntime) {
  if (runtime === "cloud") return runCloudAgent;
  if (runtime === "codex") return runCodexAgent;
  return runAgent;
}

export function prepareUserMessage(session: Session, content: string, clientMessageId?: string): ChatMessage {
  const userMsg: ChatMessage = {
    id: clientMessageId ?? newId("msg"),
    role: "user",
    content: content.trim(),
    createdAt: nowIso(),
  };
  session.messages.push(userMsg);
  if (session.title === "新任务" || session.messages.filter((m) => m.role === "user").length === 1) {
    session.title = truncate(userMsg.content, 36);
  }
  session.status = "running";
  session.lastError = undefined;
  session.remoteRetry = undefined;
  session.remoteRequestKey = undefined;
  session.localRetry = undefined;
  return userMsg;
}

export type SessionTurnHooks = {
  /** Keep approval execution and its resumed batch under the same cancellation fence. */
  controller?: AbortController;
  onEvent?: (event: AgentEvent, seq: number) => Promise<void> | void;
  /** Override settings.runtime (automations default to pig). */
  runtime?: AgentRuntime;
  /** Chain team: start resets the pipeline; continue resumes pending/error/cancelled members. */
  teamAction?: "start" | "continue";
};

/**
 * Shared pig/codex/cloud turn used by chat SSE and local automations.
 * Always persists events; `onEvent` is optional (SSE writes).
 * Chain teams (no expertId) run sequential same-session member turns.
 */
export async function runSessionTurn(
  session: Session,
  hooks: SessionTurnHooks = {},
): Promise<Session> {
  const settings = await loadSessionSettings(session);
  const requested = hooks.runtime ?? (session.executionTarget === "remote" ? "cloud" : session.executionTarget === "local" ? (session.engine || "pig") : settings.runtime);
  const runtime = requested;
  if (runtime === "cloud") {
    if (session.executionTarget === "remote" || settings.cloudMode === "remote") session.executionTarget = "remote";
    else delete session.executionTarget; // Legacy local-stub stays on its existing adapter.
  } else session.executionTarget = "local";
  if (runtime === "codex") session.engine = "codex";
  else if (runtime !== "cloud") session.engine = "pig";
  if (session.executionTarget === "remote") settings.cloudMode = "remote";
  await saveSession(session);
  if (runtime === "pig") session.deliveryMode = true;
  const controller = hooks.controller ?? new AbortController();
  runningTurns.set(session.id, controller);

  let writes = Promise.resolve();
  const emit = (event: AgentEvent) => {
    writes = writes.then(async () => {
      const record = await publishPersistedEvent(session.id, event);
      await hooks.onEvent?.(event, record.seq);
    });
  };

  try {
    const runner = pickRunner(runtime);
    const playbook = await resolveExpertPlaybook({
      expertId: session.expertId,
      expertTeamId: session.expertTeamId,
    });
    const sequential = shouldRunSequentialTeam(session, playbook.team);
    const mcp = runtime === "pig" && session.executionTarget !== "remote" ? await prepareSessionMcp(controller.signal) : undefined;
    const next = sequential
      ? await runSequentialTeamTurn(session, {
          settings,
          runtime,
          signal: controller.signal,
          emit,
          flush: () => writes,
          runner,
          action: hooks.teamAction ?? "start",
          mcpTools: mcp?.definitions,
          mcpInvoke: mcp?.invoke,
        })
      : await runner({
          session,
          settings,
          signal: controller.signal,
          emit,
          projectInstruction: await resolveProjectInstruction(session.projectId),
          expertInstruction: playbook.instruction,
          preferredSkillIds: playbook.skillIds,
          mcpTools: mcp?.definitions,
          mcpInvoke: mcp?.invoke,
          onRunCreated: async (runId: string) => { session.remoteRunId = runId; session.remoteState = "queued"; await saveSession(session); },
        });
    await writes;
    await saveSession(next);
    return next;
  } catch (err) {
    if (runtime === "cloud") {
      session.status = "error";
      session.lastError = formatCloudRemoteError(err);
      session.remoteRetry = decideRemoteRetry(err, session.remoteRunId);
      if (session.remoteRetry === "create-run") delete session.remoteRunId;
      session.localRetry = undefined;
    } else {
      session.status = "idle";
      session.lastError = formatLocalTurnError(err);
      session.localRetry = decideLocalRetry(session);
      session.remoteRetry = undefined;
    }
    await saveSession(session);
    await emit({ type: "error", message: session.lastError });
    await emit({ type: "done", session });
    await writes;
    return session;
  } finally {
    runningTurns.delete(session.id);
  }
}
