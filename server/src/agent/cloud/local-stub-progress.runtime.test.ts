import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import {
  CREATE_RUN_PROGRESS,
  FOLLOW_UP_PROGRESS,
  LOCAL_STUB_PROGRESS,
} from "./create-run-progress.ts";
import { runCloudAgent } from "./runtime.ts";

function cloudSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "sk-host-control-path-secret",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "cloud",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "cp-token-must-not-leak",
    cloudMode: "local-stub",
    ...extra,
  };
}

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_ad_progress",
    title: "local-stub progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "写一个文件",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startScriptedLlm(
  script: Array<(reqBody: string, res: ServerResponse) => void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  let turn = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const handler = script[Math.min(turn, script.length - 1)];
      turn += 1;
      handler?.(raw, res);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function stepEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === "steps");
}

function titlesAt(events: AgentEvent[], index: number): string[] {
  const ev = stepEvents(events)[index];
  return ev && ev.type === "steps" ? ev.steps.map((s) => s.title) : [];
}

describe("Milestone AD local-stub materialize progress", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("emits Chinese local-stub steps then hands off on first pig token/tool (no W/X chips)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-ad-ok-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-ad-ok-runs-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");

    const mock = await startScriptedLlm([
      (_raw, res) => {
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
                        path: "note.md",
                        content: "已写",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      },
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "已写入 note.md" } }] });
      },
    ]);

    try {
      const events: AgentEvent[] = [];
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        runsRoot,
      });

      const firstSteps = titlesAt(events, 0);
      expect(firstSteps).toContain(LOCAL_STUB_PROGRESS.materialize.title);
      expect(firstSteps).not.toContain(CREATE_RUN_PROGRESS.snapshot.title);
      expect(firstSteps).not.toContain(FOLLOW_UP_PROGRESS.followup.title);
      expect(
        stepEvents(events).some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === LOCAL_STUB_PROGRESS.start.title),
        ),
      ).toBe(true);

      const dumped = JSON.stringify(stepEvents(events));
      expect(dumped).not.toContain(CREATE_RUN_PROGRESS.create.title);
      expect(dumped).not.toContain(FOLLOW_UP_PROGRESS.reconnect.title);
      expect(dumped).not.toContain("sk-host-control-path-secret");
      expect(dumped).not.toContain("cp-token-must-not-leak");

      const firstProgress = events.findIndex((e) => e.type === "steps");
      const firstLive = events.findIndex(
        (e) => e.type === "token" || e.type === "tool_start",
      );
      expect(firstProgress).toBeGreaterThanOrEqual(0);
      expect(firstLive).toBeGreaterThan(firstProgress);

      const lastBootstrap = [...events]
        .map((e, i) => ({ e, i }))
        .reverse()
        .find(
          ({ e }) =>
            e.type === "steps" && e.steps.some((s) => s.id.startsWith("local-stub:")),
        );
      expect(lastBootstrap).toBeDefined();
      expect(lastBootstrap!.i).toBeLessThan(firstLive);

      expect(next.status).toBe("idle");
      expect(next.lastError).toBeUndefined();
      expect(next.steps.some((s) => s.id.startsWith("local-stub:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("create-run:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("follow-up:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("note.md"))).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("abort during hung local-stub turn returns idle (no zombie running chips)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-ad-ab-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-ad-ab-runs-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const hung = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve({
          url: `http://127.0.0.1:${addr.port}/v1`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const pending = runCloudAgent({
      session: emptySession(),
      settings: cloudSettings(workspaceRoot, { llmBaseUrl: hung.url }),
      signal: controller.signal,
      emit: (e) => events.push(e),
      runsRoot,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      events.some(
        (e) => e.type === "steps" && e.steps.some((s) => s.title === LOCAL_STUB_PROGRESS.start.title),
      ),
    ).toBe(true);
    controller.abort();
    const next = await pending;
    await hung.close();
    expect(next.status).toBe("idle");
    expect(next.lastError).toBeUndefined();
    expect(next.steps.every((s) => s.status !== "running")).toBe(true);
    expect(next.steps.some((s) => s.id.startsWith("local-stub:"))).toBe(false);
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
  });

  it("LLM failure uses existing Chinese banner/retry and clears bootstrap chips", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-ad-fail-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-ad-fail-runs-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const closed = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: "invalid_api_key sk-abcdefghijklmnop" } }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve({
          url: `http://127.0.0.1:${addr.port}/v1`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    try {
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { llmBaseUrl: closed.url }),
        signal: new AbortController().signal,
        emit: () => undefined,
        runsRoot,
      });
      expect(next.status).toBe("idle");
      expect(next.status).not.toBe("running");
      expect(next.lastError).toMatch(/密钥|网关|失败|无效/);
      expect(next.lastError).not.toContain("sk-abcdefghijklmnop");
      expect(next.lastError).not.toContain("sk-host-control-path-secret");
      expect(next.localRetry).toBeTruthy();
      expect(next.steps.some((s) => s.id.startsWith("local-stub:"))).toBe(false);
      expect(JSON.stringify(next.steps)).not.toContain("sk-host-control-path-secret");
      expect(JSON.stringify(next.steps)).not.toContain("cp-token-must-not-leak");
    } finally {
      await closed.close();
    }
  });
});
