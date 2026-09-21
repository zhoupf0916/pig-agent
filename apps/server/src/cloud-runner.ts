import { randomUUID } from "node:crypto";
/** Container entry point: reuse the local Pig engine without sharing host storage or credentials. */
import { mkdir, readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInWorkspace } from "./agent/sandbox.ts";
import { runAgent } from "./agent/runtime.ts";
import { normalizeSettings } from "./store/settings.ts";
import {
  extractWorkspaceSnapshot,
  packWorkspaceSnapshot,
  shouldSkipCloudHandoffName,
} from "./agent/cloud/snapshot.ts";
import type { Session } from "./types.ts";
const gateway = process.env.GATEWAY_URL || "http://gateway:8891";
const token = process.env.RUN_TOKEN || "";
// Shell children do not need the inference credential.
delete process.env.RUN_TOKEN;
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
try {
  await mkdir("/workspace", { recursive: true });
  const response = await fetch(gateway + "/task", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error("运行令牌已失效");
  const { id, input } = (await response.json()) as {
    id: string;
    input: {
      prompt: string;
      requireApproval?: boolean;
      files?: Array<{ path: string; content: string }>;
      messages: Session["messages"];
      workspace?: { snapshot: Parameters<typeof extractWorkspaceSnapshot>[0] };
    };
  };
  if (input.workspace?.snapshot)
    extractWorkspaceSnapshot(input.workspace.snapshot, "/workspace");
  for (const file of input.files || [])
    await writeFile(resolveInWorkspace("/workspace", file.path), file.content);
  const now = new Date().toISOString();
  const messages = input.messages || [];
  if (
    messages.at(-1)?.role !== "user" ||
    messages.at(-1)?.content !== input.prompt
  )
    messages.push({
      id: "prompt:" + id,
      role: "user",
      content: input.prompt,
      createdAt: now,
    });
  const deadline = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(
      Math.min(
        585,
        Math.max(30, Number(process.env.RUN_TIMEOUT_SECONDS) || 210),
      ) * 1000,
    ),
  ]);
  const result = await runAgent({
    session: {
      id,
      title: input.prompt.slice(0, 50),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages,
      steps: [],
      artifacts: [],
    },
    settings: normalizeSettings({
      workspaceRoot: "/workspace",
      llmBaseUrl: gateway + "/v1",
      llmApiKey: token,
      llmModel: "cloud-managed",
    }),
    signal: deadline,
    emit: (event) => emit({ kind: "event", event }),
    memoryPins: [],
    authorizeTool: input.requireApproval
      ? async (call) => {
          async function approvalRequest(path: string, body: unknown) {
            for (let attempt = 0; ; attempt++) {
              try {
                const r = await fetch(gateway + path, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(body),
                  signal: AbortSignal.any([
                    deadline,
                    AbortSignal.timeout(4000),
                  ]),
                });
                if (!r.ok) {
                  const error = Object.assign(
                    new Error("无法核验云端审批，操作未执行"),
                    { terminal: r.status < 500 },
                  );
                  throw error;
                }
                return (await r.json()) as { id: string; state: string };
              } catch (error) {
                if (
                  deadline.aborted ||
                  attempt >= 2 ||
                  (error as { terminal?: boolean }).terminal
                )
                  throw error;
                await new Promise((resolve) =>
                  setTimeout(resolve, 300 * (attempt + 1)),
                );
              }
            }
          }
          // Stable for this tool call: a lost response may replay the same receipt,
          // never a new authorization or a restarted tool execution.
          const requestId = randomUUID();
          const approval = await approvalRequest("/approvals", call);
          emit({
            kind: "event",
            event: {
              type: "message",
              message: {
                id: approval.id,
                role: "assistant",
                content: `操作 ${call.tool} 等待审批，尚未执行。请打开「远端运行记录」审批；等待计入本次容器时限。`,
                createdAt: new Date().toISOString(),
              },
            },
          });
          while (!deadline.aborted) {
            const decision = await approvalRequest(
              `/approvals/${approval.id}/poll`,
              { requestId },
            );
            if (decision.state === "approved") return true;
            if (decision.state === "rejected") return false;
            if (decision.state !== "pending")
              throw Error("授权已被领取，执行结果需核验；不会自动重复操作");
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(done, 700);
              function done() {
                clearTimeout(timeout);
                deadline.removeEventListener("abort", done);
                resolve();
              }
              deadline.addEventListener("abort", done, { once: true });
            });
          }
          throw Error("Aborted");
        }
      : undefined,
    projectInstruction:
      "You are running inside an isolated cloud container. The workspace is /workspace. The control plane preserves the workspace between conversation turns. Network access is restricted.",
  });
  if (deadline.aborted) throw new Error("容器任务超过执行时限");
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  async function collect(dir: string) {
    for (const entry of await readdir(join("/workspace", dir), {
      withFileTypes: true,
    })) {
      if (shouldSkipCloudHandoffName(entry.name)) continue;
      const rel = dir ? dir + "/" + entry.name : entry.name;
      const stat = await lstat(join("/workspace", rel));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (rel.split("/").length < 12) await collect(rel);
      } else if (
        stat.isFile() &&
        stat.size <= 200000 &&
        bytes + stat.size <= 2 * 1024 * 1024 &&
        files.length < 100
      ) {
        const content = await readFile(join("/workspace", rel), "utf8");
        if (!content.includes("\0")) {
          files.push({ path: rel, content });
          bytes += stat.size;
        }
      }
    }
  }
  await collect("");
  emit({
    kind: "result",
    ok: !result.lastError,
    error: result.lastError,
    files,
    snapshot: packWorkspaceSnapshot("/workspace"),
  });
} catch (error) {
  emit({
    kind: "result",
    ok: false,
    error: error instanceof Error ? error.message : "Runner failed",
    files: [],
    snapshot: (() => {
      try {
        return packWorkspaceSnapshot("/workspace");
      } catch {
        return undefined;
      }
    })(),
  });
  process.exitCode = 1;
}
