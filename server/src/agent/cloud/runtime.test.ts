import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { startCloudControlStub } from "./control-stub.ts";
import { buildCreateRunRequest, buildRemoteWorkspaceHandoff } from "./request.ts";
import { runCloudAgent } from "./runtime.ts";
import { materializeCloudWorkspace } from "./workspace.ts";

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
    id: "ses_cloud",
    title: "cloud",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "整理工作区并写一份报告",
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

describe("local-stub cloud runtime", () => {
  it("runs the pig loop in an isolated copy and syncs artifacts back", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-host-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-cloud-runs-"));
    writeFileSync(join(workspaceRoot, "messy.txt"), "todo: file me");
    writeFileSync(join(workspaceRoot, ".env"), "DEEPSEEK_API_KEY=sk-should-not-copy\n");

    const mock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_plan",
                    function: {
                      name: "update_plan",
                      arguments: JSON.stringify({
                        steps: [{ title: "写报告", status: "pending" }],
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: "call_write",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "reports/summary.md",
                        content: "# 报告\n\n已整理 messy.txt\n",
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
        sse(res, {
          choices: [{ delta: { content: "已写入 reports/summary.md，请在产物面板查看。" } }],
        });
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

      expect(readFileSync(join(workspaceRoot, "reports/summary.md"), "utf8")).toContain("报告");
      expect(next.artifacts.some((a) => a.path === "reports/summary.md" && a.action === "created")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "tool_start")).toBe(true);
      expect(events.some((e) => e.type === "steps")).toBe(true);
      expect(events.some((e) => e.type === "artifact")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
      expect(next.status).toBe("idle");

      const runDirs = (await import("node:fs")).readdirSync(runsRoot);
      expect(runDirs.length).toBe(1);
      const isolated = join(runsRoot, runDirs[0]!, "workspace");
      expect(existsSync(join(isolated, "reports/summary.md"))).toBe(true);
      expect(existsSync(join(isolated, ".env"))).toBe(false);
      const runJson = readFileSync(join(runsRoot, runDirs[0]!, "run.json"), "utf8");
      expect(runJson).not.toContain("sk-host-control-path-secret");
      expect(runJson).not.toContain("cp-token-must-not-leak");
      expect(runJson).not.toContain("sk-should-not-copy");
    } finally {
      await mock.close();
    }
  });

  it("aborts a hung stub turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-ab-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-cloud-runs-ab-"));
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
    const pending = runCloudAgent({
      session: emptySession(),
      settings: cloudSettings(workspaceRoot, { llmBaseUrl: hung.url }),
      signal: controller.signal,
      emit: () => undefined,
      runsRoot,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const next = await pending;
    await hung.close();
    expect(next.status).toBe("idle");
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
  });
});

describe("create-run payload", () => {
  it("never includes host API keys or control-plane tokens", () => {
    const settings = cloudSettings("/tmp/ws");
    const body = buildCreateRunRequest(emptySession(), settings);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(settings.llmApiKey);
    expect(dumped).not.toContain(settings.cloudToken);
    expect(body.prompt).toContain("整理");
    expect(body.sessionId).toBe("ses_cloud");
    expect(body.workspace).toBeUndefined();
  });

  it("prepends expert then project onto the remote prompt", () => {
    const settings = cloudSettings("/tmp/ws");
    const body = buildCreateRunRequest(emptySession(), settings, undefined, {
      expertInstruction: "Scout: do not edit.",
      projectInstruction: "Project: reply in Chinese.",
    });
    expect(body.prompt.indexOf("Expert instructions")).toBeLessThan(
      body.prompt.indexOf("Project instructions"),
    );
    expect(body.prompt).toContain("Scout: do not edit.");
    expect(body.prompt).toContain("整理工作区");
  });

  it("attaches a sandbox-safe snapshot without secrets", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-hand-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "visible");
    writeFileSync(join(workspaceRoot, ".env"), "DEEPSEEK_API_KEY=sk-host-control-path-secret\n");
    const settings = cloudSettings(workspaceRoot);
    const body = buildCreateRunRequest(emptySession(), settings, buildRemoteWorkspaceHandoff(settings));
    const dumped = JSON.stringify(body);
    expect(body.workspace?.snapshot?.encoding).toBe("tar.gz");
    expect(body.workspace?.snapshot?.files).toContain("ok.md");
    expect(body.workspace?.snapshot?.files?.some((f) => f.includes(".env"))).toBe(false);
    expect(dumped).not.toContain(settings.llmApiKey);
    expect(dumped).not.toContain("sk-host-control-path-secret");
  });
});

describe("workspace materialize", () => {
  it("skips env files so secrets stay on the host control path", () => {
    const source = mkdtempSync(join(tmpdir(), "pig-cloud-src-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-cloud-mat-"));
    writeFileSync(join(source, "ok.md"), "visible");
    writeFileSync(join(source, ".env.local"), "SECRET=1\n");
    writeFileSync(join(source, "id_rsa"), "fake-key");
    const isolated = materializeCloudWorkspace({
      sourceRoot: source,
      runId: "run_test",
      runsRoot,
      sessionId: "ses",
    });
    expect(readFileSync(join(isolated.workspaceRoot, "ok.md"), "utf8")).toBe("visible");
    expect(existsSync(join(isolated.workspaceRoot, ".env.local"))).toBe(false);
    expect(existsSync(join(isolated.workspaceRoot, "id_rsa"))).toBe(false);
  });
});

describe("remote cloud runtime", () => {
  it("POSTs create-run, maps SSE, and aborts the remote run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-rem-"));
    const seen: { create?: unknown; aborted: boolean; auth?: string } = { aborted: false };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          seen.create = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          seen.auth = req.headers.authorization;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "run_remote_1", status: "running" }));
        });
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_remote_1/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: run.started\ndata: ${JSON.stringify({ type: "run.started" })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: "tool.started",
            id: "t1",
            name: "write_file",
            arguments: { path: "x.md" },
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "tool.finished",
            id: "t1",
            name: "write_file",
            ok: true,
            output: "ok",
            durationMs: 3,
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "artifact.upserted",
            path: "x.md",
            action: "created",
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "assistant.message", content: "已写 x.md" })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ type: "run.idle" })}\n\n`);
        res.end();
        return;
      }
      if (req.method === "POST" && url === "/v1/runs/run_remote_1/abort") {
        seen.aborted = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    try {
      const events: AgentEvent["type"][] = [];
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, {
          cloudMode: "remote",
          cloudBaseUrl: url,
          cloudToken: "tok-abc",
        }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e.type),
      });

      expect(seen.auth).toBe("Bearer tok-abc");
      expect(JSON.stringify(seen.create)).not.toContain("sk-host-control-path-secret");
      expect(JSON.stringify(seen.create)).not.toContain("cp-token-must-not-leak");
      expect(events).toContain("tool_start");
      expect(events).toContain("tool_end");
      expect(events).toContain("artifact");
      expect(events).toContain("message");
      expect(events).toContain("done");
      expect(next.status).toBe("idle");
      expect(next.artifacts.some((a) => a.path === "x.md")).toBe(true);
      expect(next.messages.some((m) => m.role === "assistant" && m.content.includes("x.md"))).toBe(
        true,
      );
      expect(
        next.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.id === "t1")),
      ).toBe(true);
      expect(next.messages.some((m) => m.role === "tool" && m.toolCallId === "t1")).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("POSTs abort when the host signal fires mid-stream", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-rem-ab-"));
    let aborted = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_hang" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_hang/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Stay open until the client aborts.
        return;
      }
      if (req.method === "POST" && url === "/v1/runs/run_hang/abort") {
        aborted = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    const controller = new AbortController();
    const pending = runCloudAgent({
      session: emptySession(),
      settings: cloudSettings(workspaceRoot, {
        cloudMode: "remote",
        cloudBaseUrl: url,
      }),
      signal: controller.signal,
      emit: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const next = await pending;
    await new Promise<void>((r) => server.close(() => r()));
    expect(next.status).toBe("idle");
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
    expect(aborted).toBe(true);
  });

  it("uploads a snapshot, persists run id, prefers follow-up, then falls back when expired", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-cloud-fu-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-cloud-fu-runs-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "visible");
    writeFileSync(join(workspaceRoot, ".env"), "DEEPSEEK_API_KEY=sk-host-control-path-secret\n");
    writeFileSync(join(workspaceRoot, "id_rsa"), "fake-key");

    const stub = await startCloudControlStub({ runsRoot });
    try {
      const settings = cloudSettings(workspaceRoot, {
        cloudMode: "remote",
        cloudBaseUrl: stub.url,
      });

      const first = await runCloudAgent({
        session: emptySession(),
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(first.remoteRunId).toMatch(/^run_/);
      expect(first.messages.some((m) => m.content.includes("accepted workspace"))).toBe(true);
      const stored = stub.runs.get(first.remoteRunId!);
      expect(stored?.files).toContain("ok.md");
      expect(stored?.files.some((f) => f.includes(".env"))).toBe(false);
      expect(stored?.files).not.toContain("id_rsa");
      expect(stored?.prompts).toEqual(["整理工作区并写一份报告"]);

      const second = await runCloudAgent({
        session: {
          ...first,
          messages: [
            ...first.messages,
            {
              id: "u2",
              role: "user",
              content: "再写一个文件",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(second.remoteRunId).toBe(first.remoteRunId);
      expect(second.messages.some((m) => m.content.includes("[stub] follow-up: 再写一个文件"))).toBe(
        true,
      );
      expect(stored?.prompts).toEqual(["整理工作区并写一份报告", "再写一个文件"]);

      stored!.status = "expired";
      const third = await runCloudAgent({
        session: {
          ...second,
          messages: [
            ...second.messages,
            {
              id: "u3",
              role: "user",
              content: "新的一轮",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(third.remoteRunId).toBeTruthy();
      expect(third.remoteRunId).not.toBe(first.remoteRunId);
      expect(third.messages.some((m) => m.content.includes("accepted workspace"))).toBe(true);
      expect(stub.runs.get(third.remoteRunId!)?.prompts).toEqual(["新的一轮"]);
    } finally {
      await stub.close();
    }
  });
});
