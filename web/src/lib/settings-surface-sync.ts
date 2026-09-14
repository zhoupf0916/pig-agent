import type { ExecutionSurface, Settings } from "../types";
import { describeExecutionSurface, surfaceFromSettings } from "./runtime-surface";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only settings refresh interval. Same-host tabs pick up runtime chip changes from GET /api/settings. */
export const SETTINGS_SURFACE_POLL_MS = 2_000;

/** Existing execution-surface descriptors — not a third parallel status system. */
export function chipFromSettings(settings: Settings | null): ExecutionSurface {
  if (!settings) return describeExecutionSurface({ runtime: "pig" });
  return surfaceFromSettings(settings);
}

export function settingsSurfaceSyncKey(settings: Settings | null): string {
  const surface = chipFromSettings(settings);
  return [
    surface.runtime,
    surface.kind,
    surface.mode ?? "",
    surface.label,
    surface.detail,
    surface.summary,
  ].join("\u0001");
}

/**
 * Replace workstation settings with a GET /api/settings snapshot.
 * Same reference when the painted chip would not change (avoids extra renders).
 * Read-only: never PUTs settings or writes sessions / events.
 */
export function applySettingsSnapshot(prev: Settings | null, next: Settings): Settings {
  if (prev && settingsSurfaceSyncKey(prev) === settingsSurfaceSyncKey(next)) {
    return prev;
  }
  return next;
}

/**
 * Periodically GET the existing settings API (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startSettingsSurfaceSync(opts: {
  fetchSettings: () => Promise<Settings>;
  onSettings: (next: Settings) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? SETTINGS_SURFACE_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await opts.fetchSettings();
      if (!stopped) opts.onSettings(next);
    } catch {
      // keep the last good chip / settings snapshot
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
