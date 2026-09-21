import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { loadSettings, saveSettings, publicSettings } from "./settings.ts";
import { setDesktopSecrets, type DesktopSecrets } from "./desktop-secrets.ts";

afterEach(() => setDesktopSecrets(undefined));
describe("desktop credentials", () => {
  it("stores secrets only in the vault and preserves them when the redacted form is saved", async () => {
    let vault: DesktopSecrets = { llmApiKey: "", cloudToken: "" };
    setDesktopSecrets({
      read: async () => vault,
      write: async (value) => {
        vault = value;
      },
    });
    await saveSettings({
      llmApiKey: "fake-model-secret",
      cloudToken: "fake-cloud-secret", codexApiKey: "fake-codex-secret",
    });
    const disk = await readFile(join(DATA_DIR, "settings.json"), "utf8");
    expect(disk).not.toContain("fake-model-secret");
    expect(disk).not.toContain("fake-cloud-secret");
    expect(disk).not.toContain("fake-codex-secret");
    const visible = publicSettings(await loadSettings());
    expect(visible.llmApiKey).toBe("");
    expect(visible.cloudToken).toBe("");
    expect(visible.codexApiKey).toBe("");
    expect(visible.codexApiKeyConfigured).toBe(true);
    expect(visible.llmApiKeyConfigured).toBe(true);
    await saveSettings({ ...visible, llmModel: "another-model" });
    expect((await loadSettings()).llmApiKey).toBe("fake-model-secret");
    expect(vault.cloudToken).toBe("fake-cloud-secret");
    expect(vault.codexApiKey).toBe("fake-codex-secret");
  });
  it("fails closed when the OS vault fails", async () => {
    setDesktopSecrets({
      read: async () => {
        throw new Error("locked");
      },
      write: async () => {},
    });
    await expect(loadSettings()).rejects.toThrow("locked");
  });
});
