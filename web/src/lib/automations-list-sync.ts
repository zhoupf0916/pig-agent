import type { Automation } from "../types";
import { formatTime } from "./format";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only automations list refresh. Same-host tabs pick up last-run from GET /api/automations. */
export const AUTOMATIONS_LIST_POLL_MS = 2_000;

/** Existing detail copy — not a new empty-state string. */
export const AUTOMATION_LAST_RUN_NEVER = "尚未运行";

/** Last-run fields the `#/automations` list actually paints. */
export type AutomationLastRunFields = Pick<
  Automation,
  "id" | "lastRunAt" | "lastSessionId" | "lastError"
>;

export function normalizeAutomationLastRunText(value?: string | null): string | undefined {
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
 * Does not add / remove rows (create / delete stay on the existing write paths).
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
 * Periodically GET the existing automations list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Selected item may also GET /api/automations/:id for the open detail last-run.
 */
export function startAutomationsListSync(opts: {
  fetchList: () => Promise<AutomationLastRunFields[]>;
  onList: (next: AutomationLastRunFields[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<AutomationLastRunFields | null>;
  onSelected?: (next: AutomationLastRunFields) => void;
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
      if (selectedId && opts.onSelected) {
        const fromList = list.find((item) => item.id === selectedId);
        if (fromList) opts.onSelected(fromList);
        if (opts.fetchSelected) {
          try {
            const selected = await opts.fetchSelected(selectedId);
            if (!stopped && selected && selected.id === selectedId) {
              opts.onSelected(selected);
            }
          } catch {
            // keep the last good selected last-run (list already applied)
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
