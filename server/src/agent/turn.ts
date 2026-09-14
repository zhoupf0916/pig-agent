import { resolveExpertPlaybook } from "../store/experts.ts";
import { publishPersistedEvent } from "../store/events.ts";
import { resolveProjectInstruction } from "../store/projects.ts";
import { saveSession } from "../store/sessions.ts";
import { loadSettings } from "../store/settings.ts";
import type { AgentEvent, AgentRuntime, ChatMessage, Session } from "../types.ts";
import { newId, nowIso, truncate } from "../util.ts";
import { runCloudAgent } from "./cloud/runtime.ts";
import { runCodexAgent } from "./codex/runtime.ts";
import { runAgent } from "./runtime.ts";

export const runningTurns = new Map<string, AbortController>();

export function pickRunner(runtime: AgentRuntime) {
  if (runtime === "codex") return runCodexAgent;
  if (runtime === "cloud") return runCloudAgent;
  return runAgent;
}

export function prepareUserMessage(session: Session, content: string): ChatMessage {
  const userMsg: ChatMessage = {
    id: newId("msg"),
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
  return userMsg;
}

export type SessionTurnHooks = {
  onEvent?: (event: AgentEvent, seq: number) => Promise<void> | void;
  /** Override settings.runtime (automations default to pig). */
  runtime?: AgentRuntime;
};

/**
 * Shared pig/codex/cloud turn used by chat SSE and local automations.
 * Always persists events; `onEvent` is optional (SSE writes).
 */
export async function runSessionTurn(
  session: Session,
  hooks: SessionTurnHooks = {},
): Promise<Session> {
  const settings = await loadSettings();
  const runtime = hooks.runtime ?? settings.runtime;
  const controller = new AbortController();
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
    const projectInstruction = await resolveProjectInstruction(session.projectId);
    const playbook = await resolveExpertPlaybook({
      expertId: session.expertId,
      expertTeamId: session.expertTeamId,
    });
    const next = await runner({
      session,
      settings,
      signal: controller.signal,
      emit,
      projectInstruction,
      expertInstruction: playbook.instruction,
      preferredSkillIds: playbook.skillIds,
    });
    await writes;
    await saveSession(next);
    return next;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.status = "error";
    session.lastError = message;
    await saveSession(session);
    await emit({ type: "error", message });
    await emit({ type: "done", session });
    await writes;
    return session;
  } finally {
    runningTurns.delete(session.id);
  }
}
