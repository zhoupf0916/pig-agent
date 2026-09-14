import { runSessionTurn, runningTurns, prepareUserMessage } from "../agent/turn.ts";
import {
  automationIsDue,
  getAutomation,
  listAutomations,
  recordAutomationRun,
} from "../store/automations.ts";
import { getExpert, getExpertTeam } from "../store/experts.ts";
import { publishPersistedEvent } from "../store/events.ts";
import { getProject, recordSessionBound } from "../store/projects.ts";
import { createSession, getSession, saveSession } from "../store/sessions.ts";
import type { Automation, Session } from "../types.ts";

type TurnFn = typeof runSessionTurn;
let executeTurn: TurnFn = runSessionTurn;

/** Tests can replace the pig turn so cron / overlap checks do not call an LLM. */
export function setAutomationTurnForTests(fn: TurnFn | null): void {
  executeTurn = fn ?? runSessionTurn;
}

const runningAutomations = new Set<string>();

export function isAutomationRunning(id: string): boolean {
  return runningAutomations.has(id);
}

export class AutomationBusyError extends Error {
  constructor(id: string) {
    super(`Automation ${id} is already running`);
    this.name = "AutomationBusyError";
  }
}

export class AutomationNotFoundError extends Error {
  constructor() {
    super("Automation not found");
    this.name = "AutomationNotFoundError";
  }
}

async function assertPins(automation: Automation): Promise<void> {
  if (automation.expertId) {
    const expert = await getExpert(automation.expertId);
    if (!expert) throw new Error(`Expert not found: ${automation.expertId}`);
  }
  if (automation.expertTeamId) {
    const team = await getExpertTeam(automation.expertTeamId);
    if (!team) throw new Error(`Expert team not found: ${automation.expertTeamId}`);
  }
  if (automation.projectId) {
    const project = await getProject(automation.projectId);
    if (!project) throw new Error(`Project not found: ${automation.projectId}`);
  }
}

/**
 * Create a session, pin expert/project, enqueue the existing pig (or stored) runner.
 * Skips if this automation already has an in-flight run.
 */
export async function runAutomation(
  id: string,
  options: { wait?: boolean } = {},
): Promise<{ automation: Automation; session: Session }> {
  if (runningAutomations.has(id)) {
    throw new AutomationBusyError(id);
  }
  const current = await getAutomation(id);
  if (!current) throw new AutomationNotFoundError();
  if (!current.prompt.trim()) throw new Error("prompt is required");
  await assertPins(current);

  runningAutomations.add(id);
  let session: Session | null = null;
  try {
    session = await createSession({
      projectId: current.projectId,
      expertId: current.expertId,
      expertTeamId: current.expertTeamId,
    });
    if (current.projectId) await recordSessionBound(current.projectId, session.id);
    const userMsg = prepareUserMessage(session, current.prompt);
    await saveSession(session);
    await publishPersistedEvent(session.id, { type: "message", message: userMsg });
    await recordAutomationRun(id, { sessionId: session.id });

    const work = (async () => {
      try {
        const latest = (await getSession(session!.id)) ?? session!;
        const next = await executeTurn(latest, { runtime: current.runtime || "pig" });
        await recordAutomationRun(id, {
          sessionId: next.id,
          error: next.lastError ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (session) {
          session.status = "error";
          session.lastError = message;
          await saveSession(session);
        }
        await recordAutomationRun(id, { sessionId: session?.id ?? "", error: message });
      } finally {
        runningAutomations.delete(id);
      }
    })();

    if (options.wait) await work;
    else void work;

    const automation = (await getAutomation(id)) ?? current;
    const started = (await getSession(session.id)) ?? session;
    // userMsg is already on session; keep a reference so tests see the prompt
    if (!started.messages.some((m) => m.id === userMsg.id)) {
      started.messages.push(userMsg);
    }
    return { automation, session: started };
  } catch (err) {
    runningAutomations.delete(id);
    if (session && runningTurns.has(session.id)) {
      runningTurns.get(session.id)?.abort();
    }
    throw err;
  }
}

export async function tickDueAutomations(now: Date = new Date()): Promise<string[]> {
  const started: string[] = [];
  const list = await listAutomations();
  for (const automation of list) {
    if (runningAutomations.has(automation.id)) continue;
    if (!automationIsDue(automation, now)) continue;
    try {
      await runAutomation(automation.id);
      started.push(automation.id);
    } catch (err) {
      if (err instanceof AutomationBusyError) continue;
      const message = err instanceof Error ? err.message : String(err);
      await recordAutomationRun(automation.id, {
        sessionId: automation.lastSessionId ?? "",
        error: message,
      });
    }
  }
  return started;
}

/** Test helper — clear in-flight set between cases. */
export function resetAutomationRuns(): void {
  runningAutomations.clear();
}
