/** Container entry point: reuse the local Pig engine without sharing host storage or credentials. */
import { mkdir, readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInWorkspace } from "./agent/sandbox.ts";
import { runAgent } from "./agent/runtime.ts";
import { normalizeSettings } from "./store/settings.ts";
import {
  extractWorkspaceSnapshot,
  shouldSkipCloudHandoffName,
} from "./agent/cloud/snapshot.ts";
import type { Session } from "./types.ts";
const gateway = process.env.GATEWAY_URL || "http://gateway:8891";
const token = process.env.RUN_TOKEN || "";
// Shell children do not need the inference credential.
delete process.env.RUN_TOKEN;
const emit = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
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
      id: "prompt",
      role: "user",
      content: input.prompt,
      createdAt: now,
    });
  const deadline = AbortSignal.timeout(210000);
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
    projectInstruction:
      "You are running inside an isolated cloud container. The workspace is /workspace. Changes only affect this task snapshot. Network access is restricted.",
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
  });
} catch (error) {
  emit({
    kind: "result",
    ok: false,
    error: error instanceof Error ? error.message : "Runner failed",
    files: [],
  });
  process.exitCode = 1;
}
