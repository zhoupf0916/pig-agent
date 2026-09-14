import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent, Session, Settings } from "../types.ts";
import { runAgent } from "./runtime.ts";

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startMockLlm(): Promise<{ url: string; close: () => Promise<void> }> {
  let turn = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    turn += 1;
    if (turn === 1) {
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_write",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "AGENT.md",
                      content: "# Agent was here\n",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    } else {
      sse(res, {
        choices: [{ delta: { content: "已写入 AGENT.md，请在产物面板查看。" } }],
      });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

const mock = await startMockLlm();

afterAll(async () => {
  await mock.close();
});

describe("runAgent", () => {
  it("calls tools and writes a workspace artifact", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-agent-run-"));
    const session: Session = {
      id: "ses_test",
      title: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "Write AGENT.md",
          createdAt: new Date().toISOString(),
        },
      ],
      steps: [],
      artifacts: [],
    };
    const settings: Settings = {
      llmBaseUrl: mock.url,
      llmApiKey: "test",
      llmModel: "mock",
      workspaceRoot,
    };
    const events: AgentEvent["type"][] = [];
    const next = await runAgent({
      session,
      settings,
      signal: new AbortController().signal,
      emit: (e) => events.push(e.type),
    });

    expect(readFileSync(join(workspaceRoot, "AGENT.md"), "utf8")).toContain("Agent was here");
    expect(next.artifacts.some((a) => a.path === "AGENT.md")).toBe(true);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_end");
    expect(events).toContain("artifact");
    expect(events).toContain("done");
    expect(next.messages.some((m) => m.role === "assistant" && m.content.includes("AGENT.md"))).toBe(
      true,
    );
  });
});
