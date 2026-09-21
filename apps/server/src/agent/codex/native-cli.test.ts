import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../config.ts";
import { normalizeSettings } from "../../store/settings.ts";
import { runCodexAgent } from "./runtime.ts";

/** Real pinned CLI + fake Responses provider: catches catalog/protocol drift without credits. */
describe("real Codex CLI", () => {
  it("loads the generated catalog and returns a provider reply", async () => {
    let calls = 0;
    const provider = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      if (req.url !== "/responses" || req.headers.authorization !== "Bearer native-cli-test") { res.writeHead(401).end(); return; }
      calls++;
      const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CODEX_NATIVE_OK", annotations: [] }] };
      const response = { id: "resp_test", object: "response", created_at: Math.floor(Date.now()/1000), model: "deepseek-flash", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const workspace = await mkdtemp(join(tmpdir(), "pig-native-cli-"));
    try {
      const port = (provider.address() as { port: number }).port;
      const now = new Date().toISOString();
      const result = await runCodexAgent({
        settings: normalizeSettings({ runtime: "codex", codexBinaryPath: join(PROJECT_ROOT, "node_modules/.bin/codex"), codexApiKey: "native-cli-test", codexBaseUrl: `http://127.0.0.1:${port}/`, workspaceRoot: workspace }),
        session: { id: "native", title: "native", status: "idle", createdAt: now, updatedAt: now, steps: [], artifacts: [], messages: [{ id: "user", role: "user", content: "Reply CODEX_NATIVE_OK, no tools.", createdAt: now }] },
        signal: AbortSignal.timeout(20000), emit: () => {},
      });
      expect(result.lastError).toBeUndefined();
      expect(result.messages.some(m => m.role === "assistant" && m.content === "CODEX_NATIVE_OK")).toBe(true);
      expect(calls).toBe(1);
    } finally { provider.closeAllConnections(); provider.close(); await rm(workspace, { recursive: true, force: true }); }
  }, 25000);
});
