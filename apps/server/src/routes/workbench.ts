import { publishPersistedEvent } from "../store/events.ts";
import { readFile } from "node:fs/promises";
import { DATA_DIR } from "../config.ts";
import { atomicWriteJson } from "../util.ts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { join } from "node:path";
import { normalizeWorkspaceRoot } from "../agent/sandbox.ts";
import { nativeSandboxStatus } from "../agent/native-sandbox.ts";
import { runningTurns, runSessionTurn } from "../agent/turn.ts";
import { getSession, saveSession } from "../store/sessions.ts";
import { loadSessionSettings } from "../store/settings.ts";
import { applyOperation, isWorkbenchBusy, loadWorkbench, locked, operationChecks, saveWorkbench, stageOperation, undoOperation } from "../store/workbench.ts";
import { newId, nowIso } from "../util.ts";

const policySchema = z.object({ review: z.boolean(), shell: z.enum(["host", "native", "docker"]).transform((value) => value === "docker" ? "native" as const : value), network: z.boolean(), image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,200}$/), maxCalls: z.number().int().min(1).max(500), maxTokens: z.number().int().min(1000).max(5000000), maxCost: z.number().min(0).max(10000).default(0), inputPrice: z.number().min(0).max(10000), outputPrice: z.number().min(0).max(10000) });
type Template = { id: string; name: string; prompt: string; builtin?: boolean };
const BUILTINS: Template[] = [
  { id: "review", name: "代码审查", prompt: "审查工作区代码，重点检查错误处理、安全边界与测试缺口。先输出带文件路径的审查报告，不要修改文件。", builtin: true },
  { id: "organize", name: "整理资料", prompt: "检查工作区文档，提出分类与命名方案。列出将移动的文件，等待我审阅后执行。", builtin: true },
  { id: "report", name: "生成报告", prompt: "根据工作区资料撰写中文报告，注明来源文件与信息缺口。交付 Markdown 文件并读回验证。", builtin: true },
  { id: "test", name: "测试与修复", prompt: "识别项目的测试方式，运行相关测试并分析失败原因。提出最小修复，验证通过后汇报结果与剩余风险。", builtin: true },
];
const templateFile = join(DATA_DIR, "task-templates.json");
async function customTemplates(): Promise<Template[]> { try { return JSON.parse(await readFile(templateFile, "utf8")); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; } }
export function registerWorkbenchRoutes(app: Hono) {
  app.get("/api/workbench/templates", async (c) => c.json([...BUILTINS, ...await customTemplates()]));
  app.post("/api/workbench/templates", async (c) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20000) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "模板名称或指令无效" }, 400);
    try { return await locked("templates", async () => { const items = await customTemplates(); if (items.length >= 100) return c.json({ error: "最多保存 100 个模板" }, 400); const item = { id: newId("tpl"), ...parsed.data }; await atomicWriteJson(templateFile, [...items, item]); return c.json(item); }); } catch (err) { return c.json({ error: (err as Error).message }, 409); }
  });
  app.delete("/api/workbench/templates/:id", async (c) => {
    try { return await locked("templates", async () => { const items = await customTemplates(); await atomicWriteJson(templateFile, items.filter((t) => t.id !== c.req.param("id"))); return c.json({ ok: true }); }); } catch (err) { return c.json({ error: (err as Error).message }, 409); }
  });
  app.use("/api/sessions/:id/*", async (c, next) => {
    if (c.req.method !== "GET" && !c.req.path.endsWith("/abort") && isWorkbenchBusy(c.req.param("id"))) return c.json({ error: "任务正在处理文件操作，请稍后重试。" }, 409);
    if (c.req.method === "POST" && /\/(messages|retry|team-run)$/.test(c.req.path)) {
      try { return await locked(c.req.param("id"), () => next()); }
      catch (err) { return c.json({ error: (err as Error).message }, 409); }
    }
    return next();
  });
  app.get("/api/workbench/sandbox", async (c) => c.json(await nativeSandboxStatus()));
  // Compatibility for older desktop clients; no Docker daemon is used.
  app.get("/api/workbench/docker", async (c) => c.json(await nativeSandboxStatus()));
  app.get("/api/sessions/:id/workbench", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "会话不存在" }, 404);
    const settings = await loadSessionSettings(session);
    const state = await loadWorkbench(id, settings.workspaceRoot);
    const operations = state.operations.map((op) => ({ ...op,
      args: Object.fromEntries(Object.entries(op.args).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 12000) : value])),
      before: op.before.map((v) => ({ ...v, data: v.data === null ? null : Buffer.from(v.data, "base64").subarray(0, 36000).toString("base64") })),
      after: op.after.map((v) => ({ ...v, data: v.data === null ? null : Buffer.from(v.data, "base64").subarray(0, 36000).toString("base64") })),
    }));
    return c.json({ ...state, operations, runtime: session.executionTarget ? (session.executionTarget === "remote" ? "cloud" : session.engine || "pig") : settings.runtime, currentRoot: normalizeWorkspaceRoot(settings.workspaceRoot), busy: runningTurns.has(id) || isWorkbenchBusy(id), checks: await operationChecks(state), remainingSteps: session.steps.filter((s) => s.status !== "done"), lastError: session.lastError });
  });
  app.put("/api/sessions/:id/workbench", async (c) => {
    const id = c.req.param("id");
    try { return await locked(id, async () => {
      if (runningTurns.has(id)) return c.json({ error: "请等待任务结束再调整执行设置。" }, 409);
      const session = await getSession(id);
      if (!session) return c.json({ error: "会话不存在" }, 404);
      const settings = await loadSessionSettings(session);
      if (session.executionTarget ? session.executionTarget !== "local" || (session.engine || "pig") !== "pig" : settings.runtime !== "pig") return c.json({error:"这些审批与沙箱设置仅适用于本机 Pig；Codex 使用自己的沙箱，远端使用控制面策略。"},400);
      const state = await loadWorkbench(id, settings.workspaceRoot);
      const parsed = policySchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "执行设置无效，请检查预算与镜像名称。" }, 400);
      if (state.operations.some((op) => op.status === "pending" || op.status === "applying")) return c.json({ error: "请先处理已有变更单，再修改执行设置。" }, 409);
      if (parsed.data.maxCost > 0 && parsed.data.inputPrice === 0 && parsed.data.outputPrice === 0) return c.json({ error: "启用费用上限前请填写模型单价。" }, 400);
      state.policy = parsed.data;
      await saveWorkbench(id, state);
      session.deliveryMode = true;
      await saveSession(session);
      return c.json(state);
    }); } catch (err) { return c.json({ error: String((err as Error).message) }, 409); }
  });
  app.post("/api/sessions/:id/workbench/:op/:action", async (c) => {
    const id = c.req.param("id");
    let approvalController: AbortController | undefined;
    try { return await locked(id, async () => {
      if (runningTurns.has(id)) return c.json({ error: "任务运行中，不能批准或撤销文件修改。" }, 409);
      const session = await getSession(id);
      if (!session) return c.json({ error: "会话不存在" }, 404);
      const settings = await loadSessionSettings(session);
      if (session.executionTarget ? session.executionTarget !== "local" || (session.engine || "pig") !== "pig" : settings.runtime !== "pig") throw new Error("请切换回本机 Pig 后再处理变更单。");
      const state = await loadWorkbench(id, settings.workspaceRoot);
      const op = state.operations.find((item) => item.id === c.req.param("op"));
      if (!op) return c.json({ error: "变更不存在" }, 404);
      const action = c.req.param("action");
      if (action !== "reject" && action !== "acknowledge" && normalizeWorkspaceRoot(settings.workspaceRoot) !== op.root) throw new Error("当前工作区与变更单不一致，请切回原工作区再操作。");
      if (action === "approve") {
        if (state.checkpoint?.stopped) throw new Error("本轮已停止，旧审批已失效。");
        if (state.operations.find((item) => item.status === "pending")?.id !== op.id) throw new Error("请先处理当前审批。");
        if (op.status !== "pending") throw new Error("该操作已处理，不能重复执行。");
        const controller = approvalController = new AbortController();
        runningTurns.set(id, controller);
        try { await applyOperation(id, state, op, controller.signal); }
        catch (err) {
          session.lastError = (err as Error).message;
          for (const message of session.messages) if (message.toolCallId === op.callId) { message.content = `操作未完成，需要核对：${session.lastError}`; message.toolOk = false; }
          await publishPersistedEvent(id, { type: "done", session });
          await saveSession(session);
          throw err;
        } finally { if (!state.checkpoint) runningTurns.delete(id); }
      }
      else if (action === "undo") await undoOperation(id, state, op);
      else if (action === "reject" && op.status === "pending") { op.status = "rejected"; await saveWorkbench(id, state); }
      else if (action === "acknowledge" && (op.status === "applying" || op.status === "error")) { op.status = "rejected"; op.output = "用户已核对中断操作；不自动重放。"; await saveWorkbench(id, state); }
      else throw new Error("操作状态不允许此动作。");
      session.lastError = undefined;
      if (op.status === "applied" && !session.messages.some((message) => message.toolCallId === op.callId)) {
        session.messages.push({ id: newId("msg"), role: "tool", toolCallId: op.callId, content: `applied: ${op.output ?? "已执行"}`, toolOk: true, createdAt: nowIso() });
      }
      if (op.status === "rejected" && state.checkpoint) {
        const answered = new Set(session.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
        for (const message of [...session.messages]) for (const call of message.toolCalls ?? []) if (!answered.has(call.id)) {
          session.messages.push({ id: newId("msg"), role: "tool", toolCallId: call.id, content: "用户拒绝了本轮操作，未执行。后续操作已取消。", toolOk: false, createdAt: nowIso() });
        }
        state.checkpoint = { ...state.checkpoint, calls: [], stopped: true };
        await saveWorkbench(id, state);
      }
      for (const message of session.messages) if (message.role === "tool" && message.toolCallId === op.callId) {
        message.content = `${op.status}: ${op.output ?? "用户拒绝或撤销了修改，请勿再次执行同一变更。"}`;
        message.toolOk = op.status === "applied";
      }
      if (op.status === "applied") for (const artifact of op.artifacts ?? []) {
        session.artifacts = session.artifacts.filter((a) => a.path !== artifact.path);
        session.artifacts.push(artifact);
      }
      if (op.status === "undone") {
        session.artifacts = session.artifacts.filter((a) => !op.after.some((v) => v.path === a.path));
        session.steps.push({ id: newId("step"), title: "重新核验撤销后的任务结果", status: "pending", detail: `变更 ${op.id} 已撤销，原完成状态需要重新确认。` });
      }
      if (op.status === "applied") for (const step of session.steps) if (step.detail?.includes(op.id)) { step.status = "done"; step.detail = "已批准执行并记录结果。"; }
      if (!state.checkpoint || op.status !== "applied") session.messages.push({ id: newId("msg"), role: "assistant", content: `变更 ${op.id}：${op.status === "applied" ? "已执行并记录结果" : op.status === "undone" ? "已撤销并核对快照" : "已拒绝／已核对，不会自动重放"}。目标：${op.root}。`, createdAt: nowIso() });
      await publishPersistedEvent(id, { type: "done", session });
      await saveSession(session);
      if (op.status === "applied" && state.checkpoint) {
        // Return only after the continuation has reached its next durable pause or completion.
        // The per-session mutation lock serializes other approvals for the entire transition.
        const resumed = await runSessionTurn(session, { teamAction: "continue", controller: approvalController });
        return c.json({ operation: op, session: resumed });
      }
      return c.json({ operation: op, session });
    }); } catch (err) {
      if (approvalController && runningTurns.get(id) === approvalController) runningTurns.delete(id);
      return c.json({ error: (err as Error).message }, 409);
    }
  });
  app.use("/api/sessions/:id/upload", bodyLimit({ maxSize: 6 * 1024 * 1024 }));
  app.post("/api/sessions/:id/upload", async (c) => {
    const id = c.req.param("id");
    try { return await locked(id, async () => {
      if (runningTurns.has(id)) throw new Error("请等待任务结束后上传资料。");
      const session = await getSession(id);
      if (!session) return c.json({ error: "会话不存在" }, 404);
      const settings = await loadSessionSettings(session);
      if (session.executionTarget ? session.executionTarget !== "local" || (session.engine || "pig") !== "pig" : settings.runtime !== "pig") throw new Error("资料上传目前用于本机 Pig 工作区。");
      const state = await loadWorkbench(id, settings.workspaceRoot);
      if (state.root !== normalizeWorkspaceRoot(settings.workspaceRoot)) throw new Error("工作区已变化，请新建任务。");
      const body = await c.req.parseBody();
      const upload = body.file;
      if (!(upload instanceof File) || !upload.name || upload.size > 5 * 1024 * 1024) throw new Error("请选择不超过 5MB 的文件。");
      const name = upload.name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-160);
      const path = `uploads/${newId("file")}-${name}`;
      // Upload is an explicit user action. Use the same snapshots and undo journal.
      const data = Buffer.from(await upload.arrayBuffer());
      const op = await stageOperation(state, newId("upload"), "write_file", { path, content: "" });
      op.after[0]!.data = data.toString("base64");
      op.tool = "upload";
      op.status = "applying";
      await saveWorkbench(id, state);
      const { restoreVersions, capture } = await import("../store/workbench.ts");
      await restoreVersions(state.root, op.after, state.policy.shell);
      op.after = await capture(state.root, [path], state.policy.shell);
      op.status = "applied";
      op.output = `上传资料：${join(state.root, path)}`;
      await saveWorkbench(id, state);
      session.deliveryMode = true;
      session.artifacts.push({ path, action: "created", updatedAt: nowIso() });
      session.messages.push({ id: newId("msg"), role: "user", content: `已上传资料：${path}（${upload.size} 字节）。${data.includes(0) ? "这是二进制资料，需要相应解析工具。" : "可使用文件工具读取。"}`, createdAt: nowIso() });
      await publishPersistedEvent(id, { type: "done", session });
      await saveSession(session);
      return c.json({ path, session });
    }); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
}
