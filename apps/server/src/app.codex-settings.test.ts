import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { loadSettings, saveSettings, publicSettings } from "./store/settings.ts";
const app = createApp();
describe("Codex settings API", () => {
  it("redacts the dedicated key, reports readiness, and keeps it on a redacted round trip", async () => {
    const response = await app.request("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codexApiKey: "dedicated-test-key", codexBaseUrl: "https://api.deepseek.com/" }) });
    const visible = await response.json() as ReturnType<typeof publicSettings>;
    expect(visible.codexApiKey).toBe("");
    expect(visible.codexApiKeyConfigured).toBe(true);
    expect(visible.codexStatus.apiKeyPresent).toBe(true);
    await saveSettings({ ...visible, codexModel: "deepseek-flash" });
    expect((await loadSettings()).codexApiKey).toBe("dedicated-test-key");
  });
  it("copies a Pig key only on explicit request and only to the same origin", async () => {
    await saveSettings({ llmApiKey: "pig-same-origin", llmBaseUrl: "https://api.deepseek.com/v1", codexBaseUrl: "https://different.example/", codexApiKey: "dedicated-test-key" });
    expect((await app.request("/api/settings/codex/use-pig-key", { method: "POST" })).status).toBe(400);
    expect((await loadSettings()).codexApiKey).toBe("dedicated-test-key");
    await saveSettings({ codexBaseUrl: "https://api.deepseek.com/" });
    const result = await app.request("/api/settings/codex/use-pig-key", { method: "POST" });
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).not.toContain('"codexApiKey":"pig-same-origin"');
    expect((await loadSettings()).codexApiKey).toBe("pig-same-origin");
  });
});
