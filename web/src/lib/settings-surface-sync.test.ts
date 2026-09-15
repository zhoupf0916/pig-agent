import { describe, expect, it } from "vitest";
import type { Settings } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import {
  applyOpenSettingsFormSnapshot,
  applySettingsSnapshot,
  chipFromSettings,
  SETTINGS_SURFACE_POLL_MS,
  settingsFormSyncKey,
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

describe("open Settings form sync (Milestone AH)", () => {
  it("applies non-secret form fields even when the painted chip is unchanged", () => {
    const prev = settings({
      runtime: "pig",
      workspaceRoot: "/tmp/ws",
      llmModel: "deepseek-chat",
      llmApiKey: "sk-old",
    });
    const next = settings({
      runtime: "pig",
      workspaceRoot: "/tmp/other-ws",
      llmModel: "deepseek-chat",
      llmApiKey: "sk-from-get-must-not-apply",
      cloudToken: "Bearer tok-from-get",
    });
    const applied = applySettingsSnapshot(prev, next);
    expect(applied).not.toBe(prev);
    expect(applied.workspaceRoot).toBe("/tmp/other-ws");
    expect(applied.runtime).toBe("pig");
    expect(applied.llmApiKey).toBe("sk-old");
    expect(applied.cloudToken).toBe(prev.cloudToken);
    expect(chipFromSettings(applied).label).toBe("本机 Pig");
    expect(settingsFormSyncKey(applied)).not.toMatch(/sk-|Bearer |llmApiKey|cloudToken/);
  });

  it("returns the previous open-form reference when non-secret fields are unchanged", () => {
    const prev = settings({ runtime: "pig", llmApiKey: "sk-typing-locally" });
    const next = settings({ runtime: "pig", llmApiKey: "sk-from-get", cloudToken: "Bearer tok" });
    expect(applyOpenSettingsFormSnapshot(prev, next)).toBe(prev);
    expect(applySettingsSnapshot(prev, next)).toBe(prev);
  });

  it("Tab B open form follows Tab A llm / workspace / cloud / codex without overwriting secrets", async () => {
    let server = settings({
      runtime: "pig",
      llmModel: "deepseek-chat",
      workspaceRoot: "/tmp/ws",
      llmApiKey: "sk-server-1",
    });
    let tabB = settings({
      runtime: "pig",
      llmModel: "deepseek-chat",
      workspaceRoot: "/tmp/ws",
      llmApiKey: "sk-loaded",
    });
    let openForm = {
      ...tabB,
      llmApiKey: "sk-user-is-typing-now",
      cloudToken: "Bearer still-typing",
    };
    const { clock, tickInterval, focus } = fakeClock(true);

    const stop = startSettingsSurfaceSync({
      fetchSettings: async () => ({ ...server }),
      onSettings: (next) => {
        tabB = applySettingsSnapshot(tabB, next);
        openForm = applyOpenSettingsFormSnapshot(openForm, tabB);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(openForm.llmModel).toBe("deepseek-chat");
    expect(openForm.llmApiKey).toBe("sk-user-is-typing-now");

    server = settings({
      runtime: "pig",
      llmBaseUrl: "https://api.example.com/v1",
      llmModel: "deepseek-reasoner",
      workspaceRoot: "/tmp/new-ws",
      llmApiKey: "sk-must-not-overwrite-form",
    });
    tickInterval();
    await flush();
    expect(openForm.llmBaseUrl).toBe("https://api.example.com/v1");
    expect(openForm.llmModel).toBe("deepseek-reasoner");
    expect(openForm.workspaceRoot).toBe("/tmp/new-ws");
    expect(openForm.llmApiKey).toBe("sk-user-is-typing-now");
    expect(openForm.cloudToken).toBe("Bearer still-typing");
    expect(tabB.llmApiKey).toBe("sk-loaded");
    expect(chipFromSettings(tabB).label).toBe("本机 Pig");

    server = settings({
      runtime: "codex",
      codexBinaryPath: "/opt/codex",
      codexModel: "deepseek-flash",
      codexNetworkAccess: true,
      llmApiKey: "sk-codex-get",
    });
    focus();
    await flush();
    expect(openForm.runtime).toBe("codex");
    expect(openForm.codexBinaryPath).toBe("/opt/codex");
    expect(openForm.codexNetworkAccess).toBe(true);
    expect(openForm.llmApiKey).toBe("sk-user-is-typing-now");
    expect(chipFromSettings(tabB).label).toBe("本机 Codex");

    server = settings({
      runtime: "cloud",
      cloudMode: "remote",
      cloudBaseUrl: "http://127.0.0.1:8080",
      cloudRepoUrl: "https://github.com/acme/app.git",
      cloudRepoRef: "main",
      cloudToken: "Bearer tok-from-get",
    });
    tickInterval();
    await flush();
    expect(openForm.runtime).toBe("cloud");
    expect(openForm.cloudMode).toBe("remote");
    expect(openForm.cloudBaseUrl).toBe("http://127.0.0.1:8080");
    expect(openForm.cloudRepoUrl).toBe("https://github.com/acme/app.git");
    expect(openForm.cloudRepoRef).toBe("main");
    expect(openForm.cloudToken).toBe("Bearer still-typing");
    expect(chipFromSettings(tabB).label).toBe("云端 · remote");

    server = settings({ runtime: "pig", llmApiKey: "sk-back-to-pig" });
    tickInterval();
    await flush();
    expect(openForm.runtime).toBe("pig");
    expect(openForm.llmApiKey).toBe("sk-user-is-typing-now");
    expect(chipFromSettings(tabB).label).toBe("本机 Pig");
    expect(JSON.stringify({ chip: chipFromSettings(tabB), key: settingsFormSyncKey(openForm) })).not.toMatch(
      /sk-|Bearer |llmApiKey|cloudToken|DEEPSEEK_API_KEY/,
    );
    stop();
  });

  it("never puts GET secrets into the open-form snapshot or form sync key", () => {
    const prev = settings({
      runtime: "pig",
      llmApiKey: "sk-local-draft",
      cloudToken: "",
    });
    const dirty = {
      ...settings({
        runtime: "cloud",
        cloudMode: "local-stub",
        llmApiKey: "sk-abcdefghijklmnop",
        cloudToken: "Bearer tok-secret",
      }),
    };
    const applied = applyOpenSettingsFormSnapshot(prev, dirty);
    expect(applied.runtime).toBe("cloud");
    expect(applied.llmApiKey).toBe("sk-local-draft");
    expect(applied.cloudToken).toBe("");
    expect(settingsFormSyncKey(applied)).not.toMatch(/sk-|Bearer |llmApiKey|cloudToken|DEEPSEEK_API_KEY/);
    expect(JSON.stringify(chipFromSettings(applied))).not.toMatch(
      /sk-|Bearer |llmApiKey|cloudToken|DEEPSEEK_API_KEY/,
    );
  });
});
