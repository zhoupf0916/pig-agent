import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, Session, Settings } from "../types.ts";
import { dropDebugSession, readDebugTrace } from "./debug-trace.ts";
import { runAgent } from "./runtime.ts";

function settings(root: string, url: string): Settings {
  return {
    llmBaseUrl: url,
    llmApiKey: "test-key",
    llmModel: "deepseek-chat",
    workspaceRoot: root,
    runtime: "pig",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "",
    cloudMode: "local-stub",
  };
}

function listen(onBody: (raw: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      onBody(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "已按原顺序处理。" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

describe("runtime context request", () => {
  it("sends the current request before later tool groups and keeps the transcript", async () => {
    const now = "2026-09-24T00:00:00.000Z";
    const messages: ChatMessage[] = [
      { id: "goal", role: "user", content: "原始目标：交付周报，不要改锁文件。", createdAt: now },
      { id: "latest", role: "user", content: "更正：报表只允许读数据，不要修改源文件。", createdAt: now },
    ];
    for (let i = 0; i < 12; i += 1) {
      messages.push({
        id: `a${i}`,
        role: "assistant",
        content: "",
        createdAt: now,
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `input-${i}.txt` }) }],
      });
      messages.push({ id: `t${i}`, role: "tool", content: "数据".repeat(4000), toolCallId: `c${i}`, createdAt: now });
    }
    const snapshot = messages.map((message) => ({ id: message.id, content: message.content }));
    const events: import("../types.ts").AgentEvent[] = [];
    let sent = "";
    const llm = await listen((raw) => { sent = raw; });
    const session: Session = {
      id: "ses_ctx_runtime",
      title: "ctx",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages,
      steps: [],
      artifacts: [],
    };
    try {
      const result = await runAgent({
        session,
        settings: settings(mkdtempSync(join(tmpdir(), "pig-ctx-")), llm.url),
        signal: new AbortController().signal,
        emit: (event) => { events.push(event); },
        memoryPins: [],
      });
      const body = JSON.parse(sent) as { messages: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string }> }> };
      const rows = body.messages.filter((message) => message.role !== "system");
      const currentIndex = rows.findIndex((message) => message.content?.includes("报表只允许读数据"));
      const laterCall = rows.findIndex((message) => message.tool_calls?.length);
      expect(currentIndex).toBeGreaterThanOrEqual(0);
      if (laterCall >= 0) expect(currentIndex).toBeLessThan(laterCall);
      expect(sent).toContain("原始目标：交付周报");
      expect(sent).toContain("不要改锁文件");
      for (const item of snapshot) {
        expect(result.messages.find((message) => message.id === item.id)?.content).toBe(item.content);
      }
      expect(result.messages.find((message) => message.id === "t0")?.content).toBe("数据".repeat(4000));
      const span = readDebugTrace(session.id).spans.find((item) => item.kind === "model" && item.status === "ok");
      const estimate = span?.detail?.contextEstimate as { unit?: string; measuredTokens?: boolean; note?: string } | undefined;
      expect(estimate?.unit).toBe("estimated_chars");
      expect(estimate?.measuredTokens).toBe(false);
      expect(estimate?.note).toContain("不是实测 token");
      expect(JSON.stringify(estimate)).not.toContain("test-key");
      const usage = events.find((event) => event.type === "context_usage");
      expect(usage && usage.type === "context_usage" && usage.usage.scope).toBe("last_call");
      expect(result.lastContextUsage).toMatchObject({ unit: "estimated_chars", measuredTokens: false, availability: "collected" });
      expect(result.lastContextUsage?.callId).toBe(usage && usage.type === "context_usage" ? usage.usage.callId : "");
      expect(JSON.stringify(result.lastContextUsage)).not.toContain("prompt_tokens");
      expect(JSON.stringify(result.lastContextUsage)).not.toContain("test-key");
      expect(JSON.stringify(span?.detail)).not.toContain("数据数据数据");
    } finally {
      dropDebugSession(session.id);
      await llm.close();
    }
  });
});
