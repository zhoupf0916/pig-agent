import { getExpertTeam, resolveTeamMemberPlaybook } from "../store/experts.ts";
import { resolveProjectInstruction } from "../store/projects.ts";
import { saveSession } from "../store/sessions.ts";
import {
  buildTeamRun,
  cancelRemainingMembers,
  firstResumableIndex,
  shouldRunSequentialTeam,
} from "../store/team-run-state.ts";
import type {
  AgentEvent,
  AgentRuntime,
  ChatMessage,
  Session,
  Settings,
} from "../types.ts";
import { newId, nowIso } from "../util.ts";
import type { AgentRunOptions } from "../types.ts";

export const TEAM_MARKER_PREFIX = "[team]";

export {
  buildTeamRun,
  cancelRemainingMembers,
  firstResumableIndex,
  hasResumableMember,
  isResumableMemberStatus,
  normalizeTeamRun,
  shouldRunSequentialTeam,
} from "../store/team-run-state.ts";

type Runner = (options: AgentRunOptions) => Promise<Session>;

function teamMarker(content: string): ChatMessage {
  return {
    id: newId("msg"),
    role: "assistant",
    content: `${TEAM_MARKER_PREFIX} ${content}`,
    createdAt: nowIso(),
  };
}

function handoffNudge(
  teamName: string,
  name: string,
  kind: string,
  index: number,
  total: number,
): ChatMessage {
  return {
    id: newId("msg"),
    role: "user",
    content: `[harness] Sequential team handoff: you are now 「${name}」 (${kind}), step ${index + 1}/${total} of 「${teamName}」. Read the transcript. Do only this role. The user's original task still stands.`,
    createdAt: nowIso(),
  };
}

function pushAndEmit(session: Session, emit: (event: AgentEvent) => void, message: ChatMessage): void {
  session.messages.push(message);
  emit({ type: "message", message });
}

function emitTeamRun(session: Session, emit: (event: AgentEvent) => void): void {
  if (!session.teamRun) return;
  session.teamRun.updatedAt = nowIso();
  emit({ type: "team_run", teamRun: session.teamRun });
}

/** Swallow per-member idle/done so the chain stays one running SSE turn. */
export function wrapMemberEmit(emit: (event: AgentEvent) => void): (event: AgentEvent) => void {
  return (event) => {
    if (event.type === "done") return;
    if (event.type === "status" && event.status === "idle") {
      emit({ type: "status", status: "running" });
      return;
    }
    emit(event);
  };
}

export type SequentialTeamHooks = {
  settings: Settings;
  runtime: AgentRuntime;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  flush: () => Promise<void>;
  runner: Runner;
  /** start = reset pipeline; continue = resume first pending/error/cancelled member. */
  action?: "start" | "continue";
};

export async function runSequentialTeamTurn(
  session: Session,
  hooks: SequentialTeamHooks,
): Promise<Session> {
  const teamId = session.expertTeamId;
  if (!teamId) throw new Error("Session has no expertTeamId");
  const team = await getExpertTeam(teamId);
  if (!team) throw new Error("Expert team not found");
  if (!shouldRunSequentialTeam(session, team)) {
    throw new Error("Session is not a sequential chain team run");
  }

  const projectInstruction = await resolveProjectInstruction(session.projectId);
  const action = hooks.action ?? "start";

  if (action === "start" || !session.teamRun || session.teamRun.teamId !== team.id) {
    session.teamRun = await buildTeamRun(team);
  } else {
    session.teamRun.status = "running";
    session.teamRun.updatedAt = nowIso();
  }

  if (session.teamRun.members.length === 0) {
    throw new Error("Expert team has no usable members");
  }

  session.status = "running";
  session.lastError = undefined;
  emitTeamRun(session, hooks.emit);
  hooks.emit({ type: "status", status: "running" });

  const startIndex = action === "continue" ? firstResumableIndex(session.teamRun) : 0;
  if (action === "start") {
    for (const member of session.teamRun.members) {
      member.status = "pending";
      member.detail = undefined;
    }
    session.teamRun.currentIndex = 0;
    session.teamRun.status = "running";
  }

  if (startIndex >= session.teamRun.members.length) {
    session.teamRun.status = "done";
    session.status = "idle";
    emitTeamRun(session, hooks.emit);
    hooks.emit({ type: "status", status: "idle" });
    hooks.emit({ type: "done", session });
    await hooks.flush();
    await saveSession(session);
    return session;
  }

  const total = session.teamRun.members.length;
  let current = session;

  for (let i = startIndex; i < total; i += 1) {
    if (hooks.signal.aborted) {
      cancelRemainingMembers(current.teamRun!, i, "Aborted");
      break;
    }

    const member = current.teamRun!.members[i];
    if (!member) continue;
    current.teamRun!.currentIndex = i;
    member.status = "running";
    member.detail = undefined;
    emitTeamRun(current, hooks.emit);

    const memberIndex = team.expertIds.indexOf(member.expertId);
    const playbook = await resolveTeamMemberPlaybook(team.id, memberIndex);
    if (!playbook.expert || !playbook.instruction) {
      member.status = "error";
      member.detail = "Expert playbook missing";
      current.teamRun!.status = "error";
      current.status = "error";
      current.lastError = member.detail;
      emitTeamRun(current, hooks.emit);
      hooks.emit({ type: "error", message: member.detail });
      break;
    }

    pushAndEmit(current, hooks.emit, teamMarker(`${i + 1}/${total} · ${member.name} 开始`));
    pushAndEmit(
      current,
      hooks.emit,
      handoffNudge(team.name, member.name, member.kind, i, total),
    );

    const next = await hooks.runner({
      session: current,
      settings: hooks.settings,
      signal: hooks.signal,
      emit: wrapMemberEmit(hooks.emit),
      projectInstruction,
      expertInstruction: playbook.instruction,
      preferredSkillIds: playbook.skillIds,
    });
    current = next;

    if (hooks.signal.aborted) {
      const row = current.teamRun?.members[i];
      if (row && row.status !== "done") {
        row.status = "cancelled";
        row.detail = "Aborted";
      }
      if (current.teamRun) cancelRemainingMembers(current.teamRun, i + 1, "Aborted");
      current.status = "idle";
      current.lastError = undefined;
      break;
    }

    if (current.status === "error") {
      const row = current.teamRun?.members[i];
      if (row) {
        row.status = "error";
        row.detail = current.lastError;
      }
      if (current.teamRun) {
        cancelRemainingMembers(current.teamRun, i + 1, "Stopped after error");
        current.teamRun.status = "error";
      }
      emitTeamRun(current, hooks.emit);
      break;
    }

    const row = current.teamRun?.members[i];
    if (row) {
      row.status = "done";
      row.detail = undefined;
    }
    current.status = "running";
    pushAndEmit(current, hooks.emit, teamMarker(`${i + 1}/${total} · ${member.name} 完成`));
    emitTeamRun(current, hooks.emit);
    await hooks.flush();
    await saveSession(current);
  }

  if (current.teamRun) {
    const allDone = current.teamRun.members.every((m) => m.status === "done");
    if (allDone) {
      current.teamRun.status = "done";
      current.teamRun.currentIndex = Math.max(0, current.teamRun.members.length - 1);
    } else if (current.teamRun.status === "running" && hooks.signal.aborted) {
      cancelRemainingMembers(current.teamRun, current.teamRun.currentIndex, "Aborted");
    }
    current.teamRun.updatedAt = nowIso();
  }

  if (current.status !== "error") {
    current.status = "idle";
    current.lastError = undefined;
  }
  current.updatedAt = nowIso();
  emitTeamRun(current, hooks.emit);
  hooks.emit({ type: "status", status: current.status });
  hooks.emit({ type: "done", session: current });
  await hooks.flush();
  await saveSession(current);
  return current;
}

export async function applyTeamRunStop(session: Session): Promise<Session> {
  if (session.teamRun && (session.teamRun.status === "running" || session.status === "running")) {
    cancelRemainingMembers(session.teamRun, session.teamRun.currentIndex, "Stopped");
  }
  if (session.status === "running") {
    session.status = "idle";
  }
  session.updatedAt = nowIso();
  await saveSession(session);
  return session;
}
