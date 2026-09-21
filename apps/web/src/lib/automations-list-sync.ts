import type { AgentRuntime, Automation } from "../types";
import { formatTime } from "./format";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only automations directory refresh. Same-host tabs pick up the full list from GET /api/automations. */
export const AUTOMATIONS_LIST_POLL_MS = 2_000;

/** Existing detail copy — not a new empty-state string. */
export const AUTOMATION_LAST_RUN_NEVER = "尚未运行";

const RUNTIMES = new Set<AgentRuntime>(["pig", "codex", "cloud"]);

/** Last-run fields the `#/automations` list actually paints (Milestone Z). */
export type AutomationLastRunFields = Pick<
  Automation,
  "id" | "lastRunAt" | "lastSessionId" | "lastError"
>;

export function normalizeAutomationLastRunText(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAutomationText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return value;
}

function normalizeRuntime(runtime: Automation["runtime"] | string | undefined): AgentRuntime {
  return RUNTIMES.has(runtime as AgentRuntime) ? (runtime as AgentRuntime) : "pig";
}

function normalizeSchedule(schedule?: string | null): string | null {
  if (typeof schedule !== "string") return null;
  const trimmed = schedule.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalId(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function automationLastRunSyncKey(
  row: Pick<AutomationLastRunFields, "lastRunAt" | "lastSessionId" | "lastError">,
): string {
  return [
    normalizeAutomationLastRunText(row.lastRunAt) ?? "",
    normalizeAutomationLastRunText(row.lastSessionId) ?? "",
    normalizeAutomationLastRunText(row.lastError) ?? "",
  ].join("\u0001");
}

export function automationLastRunLabel(lastRunAt?: string | null): string {
  const at = normalizeAutomationLastRunText(lastRunAt);
  return at ? `上次运行：${formatTime(at)}` : `上次运行：${AUTOMATION_LAST_RUN_NEVER}`;
}

export function automationLastSessionLabel(lastSessionId?: string | null): string | undefined {
  const id = normalizeAutomationLastRunText(lastSessionId);
  return id ? `会话 ${id}` : undefined;
}

export function automationLastErrorLabel(lastError?: string | null): string | undefined {
  const err = normalizeAutomationLastRunText(lastError);
  return err ? redactSecretsForDisplay(err) : undefined;
}

function assignAutomationLastRun<T extends AutomationLastRunFields>(
  base: T,
  snap: AutomationLastRunFields,
): T {
  const next = { ...base };
  const lastRunAt = normalizeAutomationLastRunText(snap.lastRunAt);
  const lastSessionId = normalizeAutomationLastRunText(snap.lastSessionId);
  const lastError = automationLastErrorLabel(snap.lastError);
  if (lastRunAt) next.lastRunAt = lastRunAt;
  else delete next.lastRunAt;
  if (lastSessionId) next.lastSessionId = lastSessionId;
  else delete next.lastSessionId;
  if (lastError) next.lastError = lastError;
  else delete next.lastError;
  return next;
}

/**
 * Fields the `#/automations` list and open detail actually paint.
 * Drops unknown keys so snapshots never become a secret store.
 */
export function sanitizeAutomation(automation: Automation): Automation {
  const lastError = automationLastErrorLabel(automation.lastError);
  const clean: Automation = {
    id: automation.id,
    name: normalizeAutomationText(automation.name),
    enabled: Boolean(automation.enabled),
    prompt: normalizeAutomationText(automation.prompt),
    schedule: normalizeSchedule(automation.schedule),
    runtime: normalizeRuntime(automation.runtime),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
  if (automation.executionTarget === "remote" || automation.executionTarget === "local") clean.executionTarget = automation.executionTarget;
  if (automation.engine === "pig" || automation.engine === "codex") clean.engine = automation.engine;
  if (automation.misfirePolicy === "skip" || automation.misfirePolicy === "once") clean.misfirePolicy = automation.misfirePolicy;
  for (const field of ["timezone","nextFireAt","lastRemoteRunId","remoteScheduleId"] as const) {
    const value=normalizeOptionalId(automation[field]);
    if(value) clean[field]=value;
  }
  const expertId = normalizeOptionalId(automation.expertId);
  const expertTeamId = normalizeOptionalId(automation.expertTeamId);
  const projectId = normalizeOptionalId(automation.projectId);
  const lastRunAt = normalizeAutomationLastRunText(automation.lastRunAt);
  const lastSessionId = normalizeAutomationLastRunText(automation.lastSessionId);
  if (expertId) clean.expertId = expertId;
  if (expertTeamId) clean.expertTeamId = expertTeamId;
  if (projectId) clean.projectId = projectId;
  if (automation.saveArtifactsToProject) clean.saveArtifactsToProject = true;
  if (lastRunAt) clean.lastRunAt = lastRunAt;
  if (lastSessionId) clean.lastSessionId = lastSessionId;
  if (lastError) clean.lastError = lastError;
  return clean;
}

export function automationSyncKey(row: Automation): string {
  return [
    row.id,
    normalizeAutomationText(row.name),
    row.enabled ? "1" : "0",
    normalizeAutomationText(row.prompt),
    normalizeSchedule(row.schedule) ?? "",
    normalizeOptionalId(row.expertId) ?? "",
    normalizeOptionalId(row.expertTeamId) ?? "",
    normalizeOptionalId(row.projectId) ?? "",
    normalizeRuntime(row.runtime),
    row.executionTarget ?? "",row.engine ?? "",row.timezone ?? "",row.misfirePolicy ?? "",
    row.nextFireAt ?? "",row.lastRemoteRunId ?? "",row.remoteScheduleId ?? "",
    row.saveArtifactsToProject ? "1" : "0",
    automationLastRunSyncKey(row),
    row.updatedAt ?? "",
  ].join("\u0001");
}

/**
 * Patch only last-run fields on one automation (list row or open detail).
 * Same reference when nothing visible changed (avoids remounting the page).
 * Read-only: never POSTs /run or writes sessions / events.jsonl.
 */
export function applyAutomationLastRunSnapshot<T extends AutomationLastRunFields>(
  prev: T | null,
  next: AutomationLastRunFields | null,
): T | null {
  if (!prev) return prev;
  if (!next || next.id !== prev.id) return prev;
  const merged = assignAutomationLastRun(prev, next);
  if (automationLastRunSyncKey(prev) === automationLastRunSyncKey(merged)) {
    return prev;
  }
  return merged;
}

/**
 * Patch last-run fields onto existing list rows by id.
 * Same array reference when nothing last-run-visible changed.
 * Does not add / remove rows (create / delete stay on the full-list snapshot path).
 */
export function applyAutomationsListLastRun<T extends AutomationLastRunFields>(
  prev: T[],
  next: AutomationLastRunFields[],
): T[] {
  const byId = new Map(next.map((row) => [row.id, row]));
  let changed = false;
  const applied = prev.map((row) => {
    const snap = byId.get(row.id);
    if (!snap) return row;
    const merged = applyAutomationLastRunSnapshot(row, snap);
    if (merged !== row) changed = true;
    return merged ?? row;
  });
  return changed ? applied : prev;
}

/**
 * Replace the `#/automations` list with a GET /api/automations snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page).
 * Adds / updates / removes rows so Tab A create / enable / cron / rename / delete catch up.
 * Last-run fields still catch up (Milestone Z).
 * Read-only: never POSTs / PATCHes / DELETEs /runs or writes sessions / events.
 */
export function applyAutomationsListSnapshot(prev: Automation[], next: Automation[]): Automation[] {
  const clean = next.map(sanitizeAutomation);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && automationSyncKey(row) === automationSyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Replace the already-open automation with a GET /api/automations/:id snapshot.
 * Same reference when nothing visible changed (avoids remounting the page).
 * Ignores another automation's body and a missing open detail.
 * `next === null` means the open automation was deleted (gone from GET /api/automations).
 */
export function applyAutomationDetailSnapshot(
  prev: Automation | null,
  next: Automation | null,
): Automation | null {
  if (next === null) return null;
  if (!prev) return prev;
  if (next.id !== prev.id) return prev;
  const clean = sanitizeAutomation(next);
  if (automationSyncKey(prev) === automationSyncKey(clean)) return prev;
  return clean;
}

/**
 * When the open id is still in GET /api/automations, keep it.
 * When it is gone, pick the next list row (or null to clear).
 * Does not load automation detail bodies.
 */
export function nextOpenAutomationId(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): string | null {
  if (!openId) return null;
  if (list.some((item) => item.id === openId)) return openId;
  return list[0]?.id ?? null;
}

/**
 * AN-02 nail: GET /api/automations/:id only while the list still contains that id.
 * Once the list snapshot says the open id is gone, callers must rewrite hash /
 * open state first and must not request `:id`.
 */
export function shouldFetchAutomationDetail(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): boolean {
  return Boolean(openId && list.some((item) => item.id === openId));
}

/**
 * Periodically GET the existing automations list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Selected item may also GET /api/automations/:id for the open detail.
 * If the list snapshot lacks the open id, rewrite open state first and do not GET `:id`.
 */
export function startAutomationsListSync(opts: {
  fetchList: () => Promise<Automation[]>;
  onList: (next: Automation[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<Automation | null>;
  onSelected?: (next: Automation | null) => void;
  onOpenId?: (nextId: string | null) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? AUTOMATIONS_LIST_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const list = await opts.fetchList();
      if (stopped) return;
      opts.onList(list);
      const selectedId = opts.selectedId;
      if (selectedId && !shouldFetchAutomationDetail(selectedId, list)) {
        // list confirms gone — update hash / open state first; never GET :id
        opts.onOpenId?.(nextOpenAutomationId(selectedId, list));
        if (!opts.onOpenId) opts.onSelected?.(null);
        return;
      }
      if (selectedId && opts.onSelected) {
        const fromList = list.find((item) => item.id === selectedId);
        if (fromList) opts.onSelected(fromList);
        if (opts.fetchSelected) {
          try {
            const selected = await opts.fetchSelected(selectedId);
            if (stopped) return;
            if (selected && selected.id === selectedId) {
              opts.onSelected(selected);
            }
          } catch {
            // keep the last good selected (list already applied)
          }
        }
      }
    } catch {
      // keep the last good automations list
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
