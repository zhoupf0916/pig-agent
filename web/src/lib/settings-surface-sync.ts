import type { ExecutionSurface, Settings } from "../types";
import { describeExecutionSurface, surfaceFromSettings } from "./runtime-surface";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only settings refresh interval. Same-host tabs pick up chip + open Settings form from GET /api/settings. */
export const SETTINGS_SURFACE_POLL_MS = 2_000;

function normalizeSettingsText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return value;
}

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
 * Non-secret Settings form fields (llm / workspace / cloud / codex).
 * Never llmApiKey / cloudToken — those stay local to the open form.
 */
export function settingsFormSyncKey(settings: Settings | null): string {
  if (!settings) return "";
  return [
    settings.runtime === "codex" || settings.runtime === "cloud" ? settings.runtime : "pig",
    normalizeSettingsText(settings.llmBaseUrl),
    normalizeSettingsText(settings.llmModel),
    normalizeSettingsText(settings.workspaceRoot),
    normalizeSettingsText(settings.codexBinaryPath),
    normalizeSettingsText(settings.codexModel),
    settings.codexNetworkAccess ? "1" : "0",
    normalizeSettingsText(settings.cloudBaseUrl),
    settings.cloudMode === "remote" ? "remote" : "local-stub",
    normalizeSettingsText(settings.cloudRepoUrl),
    normalizeSettingsText(settings.cloudRepoRef),
  ].join("\u0001");
}

function settingsSnapshotUnchanged(prev: Settings, next: Settings): boolean {
  return (
    settingsSurfaceSyncKey(prev) === settingsSurfaceSyncKey(next) &&
    settingsFormSyncKey(prev) === settingsFormSyncKey(next)
  );
}

function keepLocalSecrets(prev: Settings, next: Settings): Settings {
  return {
    ...next,
    llmApiKey: prev.llmApiKey,
    cloudToken: prev.cloudToken,
  };
}

/**
 * Replace workstation settings with a GET /api/settings snapshot.
 * Same reference when the painted chip and non-secret form fields would not change.
 * Existing snapshots keep their secret fields (GET must not overwrite in-progress keys).
 * Read-only: never PUTs settings or writes sessions / events.
 */
export function applySettingsSnapshot(prev: Settings | null, next: Settings): Settings {
  if (prev && settingsSnapshotUnchanged(prev, next)) {
    return prev;
  }
  if (!prev) return next;
  return keepLocalSecrets(prev, next);
}

/**
 * Patch the already-open Settings form from a GET /api/settings snapshot.
 * Copies non-secret fields only. In-progress llmApiKey / cloudToken stay put.
 * Same reference when nothing visible would change (avoids remounting inputs).
 */
export function applyOpenSettingsFormSnapshot(prev: Settings, next: Settings): Settings {
  const merged: Settings = {
    ...prev,
    llmBaseUrl: next.llmBaseUrl,
    llmModel: next.llmModel,
    workspaceRoot: next.workspaceRoot,
    runtime: next.runtime,
    codexBinaryPath: next.codexBinaryPath,
    codexModel: next.codexModel,
    codexNetworkAccess: next.codexNetworkAccess,
    cloudBaseUrl: next.cloudBaseUrl,
    cloudMode: next.cloudMode,
    cloudRepoUrl: next.cloudRepoUrl,
    cloudRepoRef: next.cloudRepoRef,
    workspaceExists: next.workspaceExists,
    codexStatus: next.codexStatus,
    cloudStatus: next.cloudStatus,
    executionSurface: next.executionSurface,
  };
  if (settingsSnapshotUnchanged(prev, merged)) return prev;
  return merged;
}

/**
 * Periodically GET the existing settings API (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Same read-only path feeds the top-bar chip and an already-open Settings form.
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
