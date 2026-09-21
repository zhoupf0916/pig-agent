import { describe, expect, it } from "vitest";
import { codexEnvironment } from "./environment.ts";
import { normalizeSettings } from "../../store/settings.ts";
import { inspectCodexStatus } from "./validate.ts";

describe("Codex provider isolation", () => {
  it("uses explicit Codex settings without mutating the parent environment", () => {
    const source = { DEEPSEEK_API_KEY: "old-env-key", CODEX_BASE_URL: "https://old.example/" };
    const settings = normalizeSettings({ codexApiKey: "codex-only", codexBaseUrl: "https://new.example/v1" });
    const env = codexEnvironment(settings, source);
    expect(env.CODEX_API_KEY).toBe("codex-only");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.CODEX_BASE_URL).toBe("https://new.example/v1");
    expect(source.DEEPSEEK_API_KEY).toBe("old-env-key");
    expect(inspectCodexStatus(settings, {}).apiKeyPresent).toBe(true);
  });
  it("does not silently use Pig or ChatGPT credentials", () => {
    const settings = normalizeSettings({ llmApiKey: "pig-only" });
    expect(inspectCodexStatus(settings, {}).apiKeyPresent).toBe(false);
    expect(codexEnvironment(settings, {}).CODEX_API_KEY).toBeUndefined();
  });
});
