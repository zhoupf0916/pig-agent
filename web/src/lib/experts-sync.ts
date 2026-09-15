import type { Expert, ExpertKind, ExpertTeam, ExpertTeamMode } from "../types";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only experts refresh. Same-host tabs pick up create / edit / delete from GET /api/experts. */
export const EXPERTS_SYNC_POLL_MS = 2_000;

const KINDS = new Set<ExpertKind>(["scout", "plan", "implement", "review", "custom"]);
const MODES = new Set<ExpertTeamMode>(["chain", "parallel"]);

export function normalizeExpertText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return value;
}

function normalizeKind(kind: Expert["kind"] | string | undefined): ExpertKind {
  return KINDS.has(kind as ExpertKind) ? (kind as ExpertKind) : "custom";
}

function normalizeMode(mode: ExpertTeam["mode"] | string | undefined): ExpertTeamMode {
  return MODES.has(mode as ExpertTeamMode) ? (mode as ExpertTeamMode) : "chain";
}

function normalizeSkillIds(ids?: string[] | null): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id));
}

function normalizeExpertIds(ids?: string[] | null): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id));
}

/**
 * Fields the `#/experts` list and open detail actually paint.
 * Drops unknown keys so snapshots never become a secret store.
 */
export function sanitizeExpert(expert: Expert): Expert {
  return {
    id: expert.id,
    name: normalizeExpertText(expert.name),
    description: normalizeExpertText(expert.description),
    instruction: normalizeExpertText(expert.instruction),
    kind: normalizeKind(expert.kind),
    skillIds: normalizeSkillIds(expert.skillIds),
    bundled: Boolean(expert.bundled),
    createdAt: expert.createdAt,
    updatedAt: expert.updatedAt,
  };
}

/**
 * Fields the `#/experts` team list actually paints.
 * Drops unknown keys so snapshots never become a secret store.
 */
export function sanitizeExpertTeam(team: ExpertTeam): ExpertTeam {
  return {
    id: team.id,
    name: normalizeExpertText(team.name),
    description: normalizeExpertText(team.description),
    mode: normalizeMode(team.mode),
    expertIds: normalizeExpertIds(team.expertIds),
    bundled: Boolean(team.bundled),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export function expertSyncKey(expert: Expert): string {
  return [
    expert.id,
    normalizeKind(expert.kind),
    normalizeExpertText(expert.name),
    normalizeExpertText(expert.description),
    normalizeExpertText(expert.instruction),
    normalizeSkillIds(expert.skillIds).join("\u0002"),
    expert.bundled ? "1" : "0",
    expert.updatedAt ?? "",
  ].join("\u0001");
}

export function expertTeamSyncKey(team: ExpertTeam): string {
  return [
    team.id,
    normalizeMode(team.mode),
    normalizeExpertText(team.name),
    normalizeExpertText(team.description),
    normalizeExpertIds(team.expertIds).join("\u0002"),
    team.bundled ? "1" : "0",
    team.updatedAt ?? "",
  ].join("\u0001");
}

/**
 * Replace the `#/experts` list with a GET /api/experts snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page).
 * Adds / updates / removes rows so Tab A create / edit / delete catch up.
 * Read-only: never POSTs / PATCHes / DELETEs experts or writes sessions / events.
 */
export function applyExpertsListSnapshot(prev: Expert[], next: Expert[]): Expert[] {
  const clean = next.map(sanitizeExpert);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && expertSyncKey(row) === expertSyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Replace the `#/experts` team list with a GET /api/expert-teams snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page).
 * Adds / updates / removes rows so Tab A team-list changes catch up.
 * Read-only: never POSTs / PATCHes / DELETEs teams or writes sessions / events.
 */
export function applyExpertTeamsListSnapshot(prev: ExpertTeam[], next: ExpertTeam[]): ExpertTeam[] {
  const clean = next.map(sanitizeExpertTeam);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && expertTeamSyncKey(row) === expertTeamSyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Replace the already-open expert with a GET /api/experts/:id snapshot.
 * Same reference when nothing visible changed (avoids remounting the page).
 * Ignores another expert's body and a missing open detail.
 * `next === null` means the open expert was deleted (gone from GET /api/experts).
 */
export function applyExpertDetailSnapshot(
  prev: Expert | null,
  next: Expert | null,
): Expert | null {
  if (next === null) return null;
  if (!prev) return prev;
  if (next.id !== prev.id) return prev;
  const clean = sanitizeExpert(next);
  if (expertSyncKey(prev) === expertSyncKey(clean)) return prev;
  return clean;
}

/**
 * When the open id is still in GET /api/experts, keep it.
 * When it is gone, pick the next list row (or null to clear).
 * Does not load expert detail bodies.
 */
export function nextOpenExpertId(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): string | null {
  if (!openId) return null;
  if (list.some((item) => item.id === openId)) return openId;
  return list[0]?.id ?? null;
}

/**
 * AN-02 nail: GET /api/experts/:id only while the list still contains that id.
 * Once the list snapshot says the open id is gone, callers must rewrite hash /
 * open state first and must not request `:id`.
 */
export function shouldFetchExpertDetail(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): boolean {
  return Boolean(openId && list.some((item) => item.id === openId));
}

/**
 * Periodically GET the existing experts + teams lists (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Open detail also GET /api/experts/:id — never force-fetch when that detail is not open.
 * If the list snapshot lacks the open id, rewrite open state first and do not GET `:id`.
 */
export function startExpertsSync(opts: {
  fetchList: () => Promise<Expert[]>;
  onList: (next: Expert[]) => void;
  fetchTeams: () => Promise<ExpertTeam[]>;
  onTeams: (next: ExpertTeam[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<Expert | null>;
  onSelected?: (next: Expert | null) => void;
  onOpenId?: (nextId: string | null) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? EXPERTS_SYNC_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const [list, teams] = await Promise.all([opts.fetchList(), opts.fetchTeams()]);
      if (stopped) return;
      opts.onList(list);
      opts.onTeams(teams);
      const selectedId = opts.selectedId;
      if (selectedId && !shouldFetchExpertDetail(selectedId, list)) {
        // list confirms gone — update hash / open state first; never GET :id
        opts.onOpenId?.(nextOpenExpertId(selectedId, list));
        return;
      }
      if (selectedId && opts.fetchSelected && opts.onSelected) {
        try {
          const selected = await opts.fetchSelected(selectedId);
          if (stopped) return;
          if (selected && selected.id === selectedId) {
            opts.onSelected(selected);
          }
        } catch {
          // keep the last good open expert (lists already applied)
        }
      }
    } catch {
      // keep the last good experts / teams lists
    } finally {
      inFlight = false;
    }
  };

  const tick = () => {
    if (clock.isVisible()) void refresh();
  };

  void refresh();
  const timer = clock.setInterval(tick, intervalMs);
  clock.addListener("visibilitychange", tick);
  clock.addListener("focus", tick);

  return () => {
    stopped = true;
    clock.clearInterval(timer);
    clock.removeListener("visibilitychange", tick);
    clock.removeListener("focus", tick);
  };
}
