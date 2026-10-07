import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session, Settings } from "../types.ts";
import { runAgent } from "./runtime.ts";

process.env.PIG_COMPACTION = "off";
async function capture(skillAutoload: boolean) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const session = { id: `ses_lazy_${skillAutoload}`, title: "t", createdAt: "", updatedAt: "", status: "idle", messages: [{ id: "u", role: "user", content: "帮我写今天的日报 daily notes", createdAt: "" }], steps: [], artifacts: [] } as Session;
  const settings = { llmBaseUrl: url, llmApiKey: "t", llmModel: "m", workspaceRoot: mkdtempSync(join(tmpdir(), "pig-lazy-")), runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub" } as Settings;
  await runAgent({ session, settings, signal: new AbortController().signal, emit: () => {}, memoryPins: [], skillAutoload });
  server.close();
  return bodies[0].messages as Array<{ role: string; content: string }>;
}

describe("lazy skill loading", () => {
  it("suggests matched skills on the user turn without injecting their bodies", async () => {
    const msgs = await capture(false);
    expect(msgs[0]!.content).not.toContain("selected-skills");
    expect(msgs.find((m) => m.role === "user")!.content).toMatch(/Suggested skills[\s\S]*daily-notes/);
  });
  it("still preloads bodies when autoload is on", async () => {
    const lazy = (await capture(false))[0]!.content.length;
    const eager = (await capture(true))[0]!.content.length;
    expect(eager).toBeGreaterThan(lazy);
  });
});
