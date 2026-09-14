import { describe, expect, it } from "vitest";
import type { Settings } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import {
  applySettingsSnapshot,
  chipFromSettings,
  SETTINGS_SURFACE_POLL_MS,
  startSettingsSurfaceSync,
} from "./settings-surface-sync";
import type { SessionListSyncClock } from "./session-list-sync";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: overrides.llmBaseUrl ?? "https://api.deepseek.com/v1",
    llmApiKey: overrides.llmApiKey ?? "",
    llmModel: overrides.llmModel ?? "deepseek-chat",
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/ws",
    runtime: overrides.runtime ?? "pig",
    codexBinaryPath: overrides.codexBinaryPath ?? "",
    codexModel: overrides.codexModel ?? "deepseek-flash",
    codexNetworkAccess: overrides.codexNetworkAccess ?? false,
    cloudBaseUrl: overrides.cloudBaseUrl ?? "",
    cloudToken: overrides.cloudToken ?? "",
    cloudMode: overrides.cloudMode ?? "local-stub",
    cloudRepoUrl: overrides.cloudRepoUrl,
    cloudRepoRef: overrides.cloudRepoRef,
    executionSurface: overrides.executionSurface,
    cloudStatus: overrides.cloudStatus,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeClock(visible = true) {
  const intervals: Array<{ fn: () => void }> = [];
  const listeners = new Map<string, Set<() => void>>();
  let vis = visible;
  const clock: SessionListSyncClock = {
    setInterval: (fn) => {
      intervals.push({ fn });
      return intervals.length;
    },
    clearInterval: () => {
      intervals.length = 0;
    },
    addListener: (type, handler) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    isVisible: () => vis,
  };
  return {
    clock,
    tickInterval() {
      for (const item of [...intervals]) item.fn();
    },
    setVisible(next: boolean) {
      vis = next;
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    focus() {
      for (const fn of listeners.get("focus") ?? []) fn();
    },
  };
}

describe("settings / runtime chip sync (Milestone R)", () => {
  it("keeps a 2s poll cadence and existing execution-surface descriptors (default pig)", () => {
    expect(SETTINGS_SURFACE_POLL_MS).toBe(2_000);
    const chip = chipFromSettings(settings({ runtime: "pig" }));
    const described = describeExecutionSurface({
      runtime: "pig",
      llmModel: "deepseek-chat",
      llmBaseUrl: "https://api.deepseek.com/v1",
    });
    expect(chip).toEqual(described);
    expect(chip.runtime).toBe("pig");
    expect(chip.label).toBe("本机 Pig");
    expect(chipFromSettings(null).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous settings reference when the painted chip is unchanged", () => {
    const prev = settings({ runtime: "pig", llmApiKey: "sk-old" });
    const next = settings({ runtime: "pig", llmApiKey: "sk-new" });
    expect(applySettingsSnapshot(prev, next)).toBe(prev);
  });

  it("Tab B chip follows Tab A pig → Codex → 云端 → pig from settings snapshots", async () => {
    let server = settings({ runtime: "pig" });
    let tabB: Settings | null = settings({ runtime: "pig" });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSettingsSurfaceSync({
      fetchSettings: async () => ({ ...server }),
      onSettings: (next) => {
        tabB = applySettingsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(chipFromSettings(tabB).label).toBe("本机 Pig");

    server = settings({ runtime: "codex", llmApiKey: "sk-must-not-paint" });
    tickInterval();
    await flush();
    const codex = chipFromSettings(tabB);
    expect(codex.runtime).toBe("codex");
    expect(codex.label).toBe("本机 Codex");
    expect(codex.summary).toBe(describeExecutionSurface({ runtime: "codex" }).summary);
    expect(JSON.stringify(codex)).not.toMatch(/sk-|llmApiKey|cloudToken/);

    server = settings({ runtime: "cloud", cloudMode: "local-stub" });
    tickInterval();
    await flush();
    const cloud = chipFromSettings(tabB);
    expect(cloud.runtime).toBe("cloud");
    expect(cloud.label).toBe("云端 · local-stub");
    expect(cloud.summary).toBe(describeExecutionSurface({ runtime: "cloud" }).summary);

    server = settings({ runtime: "pig" });
    tickInterval();
    await flush();
    const back = chipFromSettings(tabB);
    expect(back.runtime).toBe("pig");
    expect(back.label).toBe("本机 Pig");
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    let server = settings({ runtime: "pig" });
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSettingsSurfaceSync({
      fetchSettings: async () => {
        calls += 1;
        return { ...server };
      },
      onSettings: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server = settings({ runtime: "codex" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never puts secrets into chip copy and does not dual-write settings", async () => {
    const snap = settings({
      runtime: "codex",
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    });
    const applied = applySettingsSnapshot(null, snap);
    const chip = chipFromSettings(applied);
    const painted = JSON.stringify(chip);
    expect(painted).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(chip.label).toBe("本机 Codex");

    const fetches: Settings[] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSettingsSurfaceSync({
      fetchSettings: async () => {
        fetches.push({ ...snap });
        return { ...snap };
      },
      onSettings: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((row) => row.runtime === "codex")).toBe(true);
    stop();
  });
});
