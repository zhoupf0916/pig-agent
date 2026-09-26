import { createServer } from "node:http";
import { mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runAgent } from "./runtime.ts";
import { normalizeSettings } from "../store/settings.ts";

it("does not execute a file write when the control plane has not acknowledged the unsafe boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pig-recovery-gate-"));
  const server = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "write", type: "function", function: { name: "write_file", arguments: '{"path":"proof.txt","content":"unsafe"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const addr = server.address(); if (!addr || typeof addr === "string") throw Error("no address");
  const phases: string[] = [];
  try {
    const result = await runAgent({
      session: { id: "ses_recovery_gate", title: "gate", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle", messages: [{ id: "u", role: "user", content: "write", createdAt: new Date().toISOString() }], steps: [], artifacts: [] },
      settings: normalizeSettings({ workspaceRoot: root, llmBaseUrl: `http://127.0.0.1:${addr.port}/v1`, llmApiKey: "fixture", llmModel: "fixture" }),
      signal: new AbortController().signal, emit() {}, memoryPins: [], checkpoint: async phase => { phases.push(phase); if (phase === "unsafe") throw Error("checkpoint unavailable"); },
    });
    expect(phases, result.lastError).toEqual(["safe", "unsafe"]);
    expect(result.lastError).toBeTruthy();
    await expect(access(join(root, "proof.txt"))).rejects.toThrow();
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
