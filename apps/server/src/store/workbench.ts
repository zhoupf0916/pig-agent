import { nativeFileTool } from "../agent/file-helper-client.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { normalizeWorkspaceRoot, resolveInWorkspace } from "../agent/sandbox.ts";
import { applyReplacements, applyUnifiedPatch, type Replacement } from "../agent/patch.ts";
import type { Artifact, ToolCall } from "../types.ts";

export type Policy = { review: boolean; shell: "host" | "docker" | "native"; network: boolean; image: string; maxCalls: number; maxTokens: number; maxCost: number; inputPrice: number; outputPrice: number };
export type FileVersion = { path: string; data: string | null; mode?: number };
export type Operation = { id: string; callId: string; tool: string; args: Record<string, unknown>; root: string; environment: Policy["shell"]; image: string; network: boolean; status: "pending" | "applying" | "applied" | "rejected" | "undone" | "error"; before: FileVersion[]; after: FileVersion[]; createdAt: string; output?: string; error?: string; artifacts?: Artifact[] };
export type Workbench = { checkpoint?: { calls: ToolCall[]; blockedCallId?: string; userMessageId?: string; stopped?: boolean }; root: string; policy: Policy; operations: Operation[]; usage: { calls: number; input: number; output: number; estimated: boolean; durationMs: number; cost: number }; interrupted?: boolean };
export const DEFAULT_POLICY: Policy = { review: false, shell: "native", network: false, image: "node:22-alpine", maxCalls: 40, maxTokens: 100000, maxCost: 0, inputPrice: 0, outputPrice: 0 };
const locks = new Set<string>();
export async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (locks.has(id)) throw new Error("该任务正在处理另一项操作，请稍后重试。");
  locks.add(id);
  try { return await work(); } finally { locks.delete(id); }
}
export const isWorkbenchBusy = (id: string) => locks.has(id);
function file(id: string) {
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  return join(DATA_DIR, "workbench", `${id}.json`);
}
export async function loadWorkbench(id: string, root: string): Promise<Workbench> {
  try { const state = JSON.parse(await readFile(file(id), "utf8")) as Workbench; state.policy = { ...DEFAULT_POLICY, ...state.policy }; if (state.policy.shell !== "native") state.policy.shell = "native"; for (const op of state.operations) if (op.environment !== "native") op.environment = "native"; return state; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  return { root: normalizeWorkspaceRoot(root), policy: { ...DEFAULT_POLICY }, operations: [], usage: { calls: 0, input: 0, output: 0, estimated: false, durationMs: 0, cost: 0 } };
}
export async function saveWorkbench(id: string, state: Workbench) { await atomicWriteJson(file(id), state); }
export const MUTATIONS = new Set(["write_file", "edit_file", "apply_patch", "delete_file", "move_file", "run_shell"]);
export function fingerprint(versions: FileVersion[]) { return createHash("sha256").update(JSON.stringify(versions)).digest("hex"); }
export async function capture(root: string, paths: string[], environment: Policy["shell"] = "host"): Promise<FileVersion[]> {
  if (!paths.length) return [];
  if (process.env.PIG_FILE_HELPER !== "1" && environment !== "host") return JSON.parse((await nativeFileTool("__capture", {paths}, {workspaceRoot:root,shellMode:environment,artifacts:[],recordArtifact:()=>{}})).output);

  const out: FileVersion[] = [];
  for (const path of paths) {
    const abs = resolveInWorkspace(root, path);
    try {
      const info = await stat(abs);
      if (!info.isFile()) throw new Error("审阅和撤销仅支持普通文件，请逐个选择文件。");
      if (info.size > 5 * 1024 * 1024) throw new Error("文件超过 5MB 快照上限。");
      out.push({ path, data: (await readFile(abs)).toString("base64"), mode: info.mode & 0o777 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      out.push({ path, data: null });
    }
  }
  return out;
}
export async function stageOperation(state: Workbench, callId: string, tool: string, args: Record<string, unknown>): Promise<Operation> {
  const existing = state.operations.find((op) => op.callId === callId);
  if (existing) return existing;
  if (state.operations.some((op) => op.status === "pending" || op.status === "applying")) throw new Error("请先处理当前审批，一次只能审批一项。");
  const paths = tool === "run_shell" || tool === "http_fetch" ? [] : tool === "move_file" ? [String(args.from ?? ""), String(args.to ?? "")] : [String(args.path ?? "")];
  if (paths.some((p) => !p || p === ".")) throw new Error("必须指定文件路径。");
  const before = await capture(state.root, paths, state.policy.shell);
  const after = before.map((v) => ({ ...v }));
  const first = after[0];
  if (first) {
    const old = first.data === null ? "" : Buffer.from(first.data, "base64").toString("utf8");
    let next = old;
    if (tool !== "write_file" && first.data === null) throw new Error("源文件不存在。");
    if (tool === "write_file") next = String(args.content ?? "");
    if (tool === "edit_file") {
      const needle = String(args.old_string ?? "");
      if (!needle || old.split(needle).length !== 2) throw new Error("待替换文字必须恰好匹配一次。");
      next = old.replace(needle, String(args.new_string ?? ""));
    }
    if (tool === "apply_patch") next = Array.isArray(args.replacements) && args.replacements.length ? applyReplacements(old, args.replacements as Replacement[]) : applyUnifiedPatch(old, String(args.patch ?? ""));
    if (next.length > 400000 && tool !== "move_file" && tool !== "delete_file") throw new Error("内容超过 400000 字符上限。");
    first.data = tool === "delete_file" || tool === "move_file" ? null : Buffer.from(next).toString("base64");
    if (tool === "move_file") {
      if (after[1]!.data !== null) throw new Error("目标已存在，不能覆盖。");
      after[1] = { ...before[0]!, path: paths[1]! };
    }
  }
  const op: Operation = { id: newId("op"), callId, tool, args, root: state.root, environment: state.policy.shell, image: state.policy.image, network: state.policy.network, status: "pending", before, after, createdAt: nowIso() };
  state.operations.push(op);
  return op;
}
export async function assertUnchanged(root: string, expected: FileVersion[], environment: Policy["shell"] = "host") {
  if (fingerprint(await capture(root, expected.map((v) => v.path), environment)) !== fingerprint(expected)) throw new Error("文件自预览后已变化，操作已阻止。请重新生成变更，避免覆盖新的修改。");
}
export async function restoreVersions(root: string, versions: FileVersion[], environment: Policy["shell"] = "host") {
  if (process.env.PIG_FILE_HELPER !== "1" && environment !== "host") { await nativeFileTool("__restore", {versions}, {workspaceRoot:root,shellMode:environment,artifacts:[],recordArtifact:()=>{}}); return; }

  for (const v of versions) {
    const abs = resolveInWorkspace(root, v.path);
    if (v.data === null) await rm(abs, { force: true });
    else { await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, Buffer.from(v.data, "base64"), { mode: v.mode }); }
  }
}
export async function operationChecks(state: Workbench) {
  return Promise.all(state.operations.map(async (op) => {
    if (op.status !== "applied" || !op.after.length) return { id: op.id, result: op.status === "applied" ? "命令已执行，文件结果需另行验证" : op.status };
    try { await assertUnchanged(op.root, op.after, op.environment); return { id: op.id, result: "磁盘内容核验通过" }; }
    catch { return { id: op.id, result: "磁盘内容与交付快照不同" }; }
  }));
}

export async function applyOperation(sessionId: string, state: Workbench, op: Operation, signal?: AbortSignal) {
  if (op.status !== "pending") throw new Error("该操作已处理，不能重复执行。");
  await assertUnchanged(op.root, op.before, op.environment);
  op.status = "applying";
  await saveWorkbench(sessionId, state);
  try {
    const { executeTool } = await import("../agent/tools.ts");
    const artifacts: Artifact[] = [];
    const result = await executeTool(op.tool, op.args, {
      workspaceRoot: op.root, artifacts, signal, shellMode: op.environment, dockerImage: op.image, dockerNetwork: op.network,
      recordArtifact: (path, action, extra) => artifacts.push({ path, action, ...extra, updatedAt: nowIso() }),
    });
    const actual = await capture(op.root, op.after.map((v) => v.path), op.environment);
    if (actual.some((v, i) => v.data !== op.after[i]?.data)) throw new Error("执行后内容与预览不符，需要人工核对。");
    op.after = actual;
    op.artifacts = artifacts;
    op.output = result.output;
    op.status = "applied";
  } catch (err) { op.status = "error"; op.error = err instanceof Error ? err.message : String(err); throw err; }
  finally { await saveWorkbench(sessionId, state); }
  return op;
}
export async function undoOperation(sessionId: string, state: Workbench, op: Operation) {
  if (op.status !== "applied" || !op.before.length) throw new Error("该操作不能自动撤销；命令执行需要人工核对。");
  await assertUnchanged(op.root, op.after, op.environment);
  op.status = "applying";
  await saveWorkbench(sessionId, state);
  try { await restoreVersions(op.root, op.before, op.environment); await assertUnchanged(op.root, op.before, op.environment); op.status = "undone"; }
  catch (err) { op.status = "error"; op.error = err instanceof Error ? err.message : String(err); throw err; }
  finally { await saveWorkbench(sessionId, state); }
}
