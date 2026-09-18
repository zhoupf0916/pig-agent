import type { Expert, ExpertKind, ExpertTeam, ExpertTeamMode, ProjectSummary } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";
import { SESSION_PIN_UNBOUND } from "./session-pin-sync";

/** Read-only workbench pin-dropdown catalogs. Same-host tabs pick up create / rename / delete. */
export const PIN_CATALOG_POLL_MS = 2_000;

const KINDS = new Set<ExpertKind>(["scout", "plan", "implement", "review", "custom"]);
const MODES = new Set<ExpertTeamMode>(["chain", "parallel"]);

export function normalizePinCatalogText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return redactSecretsForDisplay(value);
}

function normalizeKind(kind: Expert["kind"] | string | undefined): ExpertKind {
  return KINDS.has(kind as ExpertKind) ? (kind as ExpertKind) : "custom";
}

function normalizeMode(mode: ExpertTeam["mode"] | string | undefined): ExpertTeamMode {
  return MODES.has(mode as ExpertTeamMode) ? (mode as ExpertTeamMode) : "chain";
}

function normalizeIds(ids?: string[] | null): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id));
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Dropdown-visible fields (id + name). Drops unknown keys so snapshots never store secrets. */
export type PinCatalogOption = { id: string; name: string };

export function pinCatalogOptionKey(row: PinCatalogOption): string {
  return [row.id, normalizePinCatalogText(row.name)].join("\u0001");
}

/**
 * Fields the workbench 项目 dropdown actually paints, plus list-side counts already on GET /api/projects.
 * Drops unknown keys so snapshots never become a secret store.
 */
export function sanitizePinProject(row: ProjectSummary): ProjectSummary {
  return {
    id: row.id,
    name: normalizePinCatalogText(row.name),
    instruction: normalizePinCatalogText(row.instruction),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    memberCount: normalizeCount(row.memberCount),
    todoCount: normalizeCount(row.todoCount),
    assetCount: normalizeCount(row.assetCount),
    sessionCount: normalizeCount(row.sessionCount),
  };
}

/**
 * Fields the workbench 专家 dropdown actually paints (id + name).
 * Other known Expert fields stay typed for AutomationsPanel reuse; unknown keys drop.
 */
export function sanitizePinExpert(expert: Expert): Expert {
  return {
    id: expert.id,
    name: normalizePinCatalogText(expert.name),
    description: normalizePinCatalogText(expert.description),
    instruction: normalizePinCatalogText(expert.instruction),
    kind: normalizeKind(expert.kind),
    skillIds: normalizeIds(expert.skillIds),
    bundled: Boolean(expert.bundled),
    createdAt: expert.createdAt,
    updatedAt: expert.updatedAt,
  };
}

/**
 * Fields the workbench 小队 dropdown actually paints (id + name).
 * Other known team fields stay typed for AutomationsPanel reuse; unknown keys drop.
 */
export function sanitizePinTeam(team: ExpertTeam): ExpertTeam {
  return {
    id: team.id,
    name: normalizePinCatalogText(team.name),
    description: normalizePinCatalogText(team.description),
    mode: normalizeMode(team.mode),
    expertIds: normalizeIds(team.expertIds),
    bundled: Boolean(team.bundled),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export function pinProjectCatalogKey(row: ProjectSummary): string {
  return pinCatalogOptionKey(row);
}

export function pinExpertCatalogKey(row: Expert): string {
  return pinCatalogOptionKey(row);
}

export function pinTeamCatalogKey(row: ExpertTeam): string {
  return [pinCatalogOptionKey(row), normalizeIds(row.expertIds).join("\u0002")].join("\u0001");
}

function applyCatalog<T extends PinCatalogOption>(
  prev: T[],
  next: T[],
  sanitize: (row: T) => T,
): T[] {
  const clean = next.map(sanitize);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && pinCatalogOptionKey(row) === pinCatalogOptionKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Replace the workbench 项目 pin-dropdown catalog with a GET /api/projects snapshot.
 * Same array reference when dropdown-visible id / name are unchanged.
 * Adds / updates / removes rows so Tab A create / rename / delete catch up.
 * Read-only: never POSTs / PATCHes / DELETEs projects or writes sessions / events.
 */
export function applyPinProjectCatalogSnapshot(
  prev: ProjectSummary[],
  next: ProjectSummary[],
): ProjectSummary[] {
  return applyCatalog(prev, next, sanitizePinProject);
}

/**
 * Replace the workbench 专家 pin-dropdown catalog with a GET /api/experts snapshot.
 * Same array reference when dropdown-visible id / name are unchanged.
 * Adds / updates / removes rows so Tab A create / rename / delete catch up.
 * Read-only: never POSTs / PATCHes / DELETEs experts or writes sessions / events.
 */
export function applyPinExpertCatalogSnapshot(prev: Expert[], next: Expert[]): Expert[] {
  return applyCatalog(prev, next, sanitizePinExpert);
}

/**
 * Replace the workbench 小队 pin-dropdown catalog with a GET /api/expert-teams snapshot.
 * Same array reference when dropdown-visible id / name / expertIds are unchanged.
 * Adds / updates / removes rows so Tab A create / rename / delete / member-clear catch up.
 * Read-only: never POSTs / PATCHes / DELETEs teams or writes sessions / events.
 */
export function applyPinTeamCatalogSnapshot(prev: ExpertTeam[], next: ExpertTeam[]): ExpertTeam[] {
  const clean = next.map(sanitizePinTeam);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && pinTeamCatalogKey(row) === pinTeamCatalogKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/** Chat-header select options: existing 未绑定 plus catalog rows. Milestone Y label unchanged. */
export function pinCatalogSelectOptions(
  catalog: Array<{ id: string; name: string }>,
): Array<{ value: string; label: string }> {
  return [
    { value: "", label: SESSION_PIN_UNBOUND },
    ...catalog.map((row) => ({
      value: row.id,
      label: normalizePinCatalogText(row.name) || row.id,
    })),
  ];
}

/**
 * Periodically GET the existing project / expert / team catalogs (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startPinCatalogSync(opts: {
  fetchProjects: () => Promise<ProjectSummary[]>;
  onProjects: (next: ProjectSummary[]) => void;
  fetchExperts: () => Promise<Expert[]>;
  onExperts: (next: Expert[]) => void;
  fetchTeams: () => Promise<ExpertTeam[]>;
  onTeams: (next: ExpertTeam[]) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? PIN_CATALOG_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const [projects, experts, teams] = await Promise.all([
        opts.fetchProjects(),
        opts.fetchExperts(),
        opts.fetchTeams(),
      ]);
      if (stopped) return;
      opts.onProjects(projects);
      opts.onExperts(experts);
      opts.onTeams(teams);
    } catch {
      // keep the last good pin-dropdown catalogs
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
