import type { ExpertTeam, Session, TeamRun, TeamRunMember, TeamRunMemberStatus } from "../types.ts";
import { nowIso } from "../util.ts";
import { getExpert } from "./experts.ts";

const MEMBER_STATUSES = new Set<TeamRunMemberStatus>([
  "pending",
  "running",
  "done",
  "error",
  "cancelled",
]);

/**
 * Same-session sequential chain (Milestone I).
 * `expertId` wins (single role). Parallel teams stay on the concatenated path.
 */
export function shouldRunSequentialTeam(session: Session, team?: ExpertTeam | null): boolean {
  if (session.expertId) return false;
  if (!session.expertTeamId) return false;
  if (!team || team.id !== session.expertTeamId) return false;
  return team.mode === "chain" && team.expertIds.length > 0;
}

export function normalizeTeamRun(raw: TeamRun | undefined): TeamRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.teamId !== "string" || !raw.teamId.trim()) return undefined;
  const members: TeamRunMember[] = Array.isArray(raw.members)
    ? raw.members
        .filter((m) => m && typeof m.expertId === "string" && m.expertId.trim())
        .map((m) => ({
          expertId: m.expertId.trim(),
          name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : m.expertId,
          kind: m.kind ?? "custom",
          status: MEMBER_STATUSES.has(m.status) ? m.status : "pending",
          detail: typeof m.detail === "string" ? m.detail : undefined,
        }))
    : [];
  const status =
    raw.status === "idle" ||
    raw.status === "running" ||
    raw.status === "done" ||
    raw.status === "error" ||
    raw.status === "cancelled"
      ? raw.status
      : "idle";
  return {
    teamId: raw.teamId.trim(),
    teamName: typeof raw.teamName === "string" && raw.teamName.trim() ? raw.teamName.trim() : raw.teamId,
    strategy: "same-session",
    status,
    currentIndex:
      typeof raw.currentIndex === "number" && Number.isFinite(raw.currentIndex)
        ? Math.max(0, Math.floor(raw.currentIndex))
        : 0,
    members,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : nowIso(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
  };
}

export async function buildTeamRun(team: ExpertTeam): Promise<TeamRun> {
  const members: TeamRunMember[] = [];
  for (const id of team.expertIds) {
    const expert = await getExpert(id);
    if (!expert) continue;
    members.push({
      expertId: expert.id,
      name: expert.name,
      kind: expert.kind,
      status: "pending",
    });
  }
  const ts = nowIso();
  return {
    teamId: team.id,
    teamName: team.name,
    strategy: "same-session",
    status: "running",
    currentIndex: 0,
    members,
    startedAt: ts,
    updatedAt: ts,
  };
}

export function cancelRemainingMembers(teamRun: TeamRun, fromIndex: number, detail?: string): void {
  for (let i = fromIndex; i < teamRun.members.length; i += 1) {
    const member = teamRun.members[i];
    if (!member) continue;
    if (member.status === "done") continue;
    member.status = "cancelled";
    if (detail) member.detail = detail;
  }
  teamRun.status = "cancelled";
  teamRun.updatedAt = nowIso();
}

/** Statuses the UI treats as 「继续小队」 and the runner can resume. */
export function isResumableMemberStatus(status: TeamRunMemberStatus): boolean {
  return status === "pending" || status === "error" || status === "running" || status === "cancelled";
}

export function hasResumableMember(teamRun: TeamRun | undefined): boolean {
  return Boolean(teamRun?.members.some((m) => isResumableMemberStatus(m.status)));
}

export function firstResumableIndex(teamRun: TeamRun): number {
  const idx = teamRun.members.findIndex((m) => isResumableMemberStatus(m.status));
  return idx >= 0 ? idx : teamRun.members.length;
}
