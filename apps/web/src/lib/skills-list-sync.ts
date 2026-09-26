import type { SkillMeta } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only Settings skills/ list refresh. Same-host tabs pick up add / edit / delete from GET /api/skills. */
export const SKILLS_LIST_POLL_MS = 2_000;

export function normalizeSkillText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return redactSecretsForDisplay(value);
}

function normalizeKeywords(keywords?: string[] | null): string[] | undefined {
  if (!Array.isArray(keywords) || keywords.length === 0) return undefined;
  return keywords.map((kw) => normalizeSkillText(String(kw)));
}

/**
 * Fields the Settings `skills/` list actually paints (and Experts checkboxes reuse).
 * Drops unknown keys / skill body so snapshots never become a secret store.
 */
export function sanitizeSkillMeta(skill: SkillMeta): SkillMeta {
  const clean: SkillMeta = {
    name: normalizeSkillText(skill.name),
    description: normalizeSkillText(skill.description),
    filename: normalizeSkillText(skill.filename),
  };
  if (skill.displayName) clean.displayName = normalizeSkillText(skill.displayName);
  const keywords = normalizeKeywords(skill.keywords);
  if (keywords) clean.keywords = keywords;
  return clean;
}

export function skillSyncKey(skill: SkillMeta): string {
  return [
    normalizeSkillText(skill.name),
    normalizeSkillText(skill.displayName),
    normalizeSkillText(skill.description),
    normalizeSkillText(skill.filename),
    (skill.keywords ?? []).map((kw) => normalizeSkillText(kw)).join("\u0002"),
  ].join("\u0001");
}

/**
 * Replace the Settings skills list with a GET /api/skills snapshot.
 * Same array reference when nothing visible changed (avoids remounting the modal).
 * Adds / updates / removes rows so Tab A skills/*.md add / edit / delete catch up.
 * Read-only: never POSTs / PUTs / DELETEs skills or writes settings / sessions / events.
 */
export function applySkillsListSnapshot(prev: SkillMeta[], next: SkillMeta[]): SkillMeta[] {
  const clean = next.map(sanitizeSkillMeta);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && skillSyncKey(row) === skillSyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Periodically GET the existing skills list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startSkillsListSync(opts: {
  fetchList: () => Promise<SkillMeta[]>;
  onList: (next: SkillMeta[]) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? SKILLS_LIST_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await opts.fetchList();
      if (!stopped) opts.onList(next);
    } catch {
      // keep the last good skills list
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
