import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decideFileEdit, workspaceEditPathError, workspaceFileRevision } from "@pig-agent/contracts";
import { nativeFileTool } from "../agent/file-helper-client.ts";
import { atomicWriteJson } from "../util.ts";
import { DATA_DIR } from "../config.ts";
import { readWorkspaceText } from "../workspace.ts";
import { listSessionRecords } from "./sessions.ts";

const legacyHistoryFile = () => join(DATA_DIR, "workspace-file-versions.json");
const historyFile = (workspaceRoot: string) => {
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32);
  return join(DATA_DIR, "workspace-file-versions", `${id}.json`);
};
const chains = new Map<string, Promise<unknown>>();
const activeTurns = new Map<string, number>();

type Version = { workspaceRoot: string; path: string; revision: string; content: string; updatedAt: string };

function withWorkspaceLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  chains.set(root, run);
  void run.finally(() => { if (chains.get(root) === run) chains.delete(root); }).catch(() => undefined);
  return run;
}

async function readHistory(workspaceRoot: string): Promise<Version[]> {
  try {
    const own = JSON.parse(await readFile(historyFile(workspaceRoot), "utf8")) as Version[];
    return own.filter((item) => item.workspaceRoot === workspaceRoot);
  } catch {
    try {
      const legacy = JSON.parse(await readFile(legacyHistoryFile(), "utf8")) as Version[];
      return legacy.filter((item) => item.workspaceRoot === workspaceRoot);
    } catch {
      return [];
    }
  }
}

/** Hold the workspace while a local turn mutates it so a save cannot land in the middle. */
export async function trackWorkspaceTurn<T>(workspaceRoot: string, work: () => Promise<T>): Promise<T> {
  await withWorkspaceLock(workspaceRoot, async () => {
    activeTurns.set(workspaceRoot, (activeTurns.get(workspaceRoot) ?? 0) + 1);
  });
  try {
    return await work();
  } finally {
    await withWorkspaceLock(workspaceRoot, async () => {
      const next = (activeTurns.get(workspaceRoot) ?? 1) - 1;
      if (next <= 0) activeTurns.delete(workspaceRoot);
      else activeTurns.set(workspaceRoot, next);
    });
  }
}

export async function workspaceFileHistory(workspaceRoot: string, path: string): Promise<Version[]> {
  return (await readHistory(workspaceRoot)).filter((item) => item.path === path);
}

export async function saveWorkspaceFileEdit(input: {
  workspaceRoot: string;
  path: string;
  content: string;
  baseRevision: string;
}): Promise<{ path: string; revision: string } | { error: string; status: 409 | 400 }> {
  const pathError = workspaceEditPathError(input.path);
  if (pathError) return { error: pathError, status: 400 };
  if (Buffer.byteLength(input.content, "utf8") > 200_000) return { error: "文件过大，不能在工作台编辑", status: 400 };
  return withWorkspaceLock(input.workspaceRoot, async () => {
  if ((activeTurns.get(input.workspaceRoot) ?? 0) > 0) {
    return { error: "任务正在使用该工作区，不能写入", status: 409 };
  }
  const sessions = await listSessionRecords();
  const busy = sessions.some(
    (session) =>
      session.status === "running" &&
      session.executionTarget !== "remote" &&
      (session.workspaceRoot ?? input.workspaceRoot) === input.workspaceRoot,
  );
  let current: { path: string; content: string; binary: boolean; size: number };
  try {
    current = await readWorkspaceText(input.workspaceRoot, input.path);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "无法读取文件", status: 400 };
  }
  if (current.binary || current.size > 200_000) {
    return { error: current.binary ? "二进制文件不能在工作台编辑" : "文件过大，不能在工作台编辑", status: 400 };
  }
  const currentRevision = workspaceFileRevision(current.content);
  const decision = decideFileEdit({
    canWrite: true,
    workspaceBusy: busy,
    baseRevision: input.baseRevision,
    currentRevision,
  });
  if (decision === "busy") return { error: "任务正在使用该工作区，不能写入", status: 409 };
  if (decision === "conflict") return { error: "文件已变化，请重新打开后再保存", status: 409 };
  const versions = await readHistory(input.workspaceRoot);
  versions.push({ workspaceRoot: input.workspaceRoot, path: current.path, revision: currentRevision, content: current.content, updatedAt: new Date().toISOString() });
  // Persist a recoverable pre-write snapshot before changing the workspace.
  await atomicWriteJson(historyFile(input.workspaceRoot), versions);
  try {
    await nativeFileTool("write_file", { path: current.path, content: input.content }, {
      workspaceRoot: input.workspaceRoot,
      shellMode: "native",
      artifacts: [],
      recordArtifact() {},
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "写入失败", status: 400 };
  }

  return { path: current.path, revision: workspaceFileRevision(input.content) };
  });
}
