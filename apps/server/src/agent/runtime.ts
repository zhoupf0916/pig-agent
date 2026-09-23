import { computerToolDefinition, executeComputerTool, hasComputerBridge } from "../desktop/computer.ts";
import { loadWorkbench, saveWorkbench, stageOperation, applyOperation, MUTATIONS } from "../store/workbench.ts";
import { saveSession } from "../store/sessions.ts";
import { normalizeWorkspaceRoot } from "./sandbox.ts";
import type {
  AgentEvent,
  Artifact,
  ChatMessage,
  PlanStep,
  Session,
  Settings,
} from "../types.ts";
import { newId, nowIso, safeJsonParse } from "../util.ts";
import { formatMemoryPinBlock, listRecentPinTexts } from "../store/memory.ts";
import { formatBoundInstructionBlock } from "./bound-instructions.ts";
import {
  LOCAL_TURN_MESSAGES,
  decideLocalRetry,
  formatLocalTurnError,
} from "./local-errors.ts";
import { complete } from "./openai.ts";
import { SandboxError } from "./sandbox.ts";
import { nativeSandboxStatus } from "./native-sandbox.ts";
import { loadSkill, loadSuggestedSkills, type ScoredSkill } from "./skills.ts";
import { parseMcpToolName } from "@pig-agent/contracts";
import { requireMcpTarget } from "../store/mcp-servers.ts";
import { executeTool, sandboxFromError, summarizeToolArgs, type ToolContext, type ToolSandboxFact, TOOL_DEFINITIONS } from "./tools.ts";
import { cancelRunningDebugSpans, debugDetail, recordDebugSpan } from "./debug-trace.ts";

function providerHost(baseUrl: string): string {
  try {
    return baseUrl ? new URL(baseUrl).host : "未采集";
  } catch {
    return "未采集";
  }
}

function requestFrom(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("request" in error)) return null;
  return (error as { request?: unknown }).request ?? null;
}

let sandboxProbe: Promise<{ available: boolean; backend: string; error?: string }> | undefined;

function measureSandbox() {
  sandboxProbe ??= nativeSandboxStatus();
  return sandboxProbe;
}

export class ToolAuthorizationDenied extends Error {}

export const MAX_TURNS = 20;
export const MAX_CONSECUTIVE_ERRORS = 3;
export const MAX_HISTORY_CHARS = 80_000;

export async function buildSystemPrompt(
  settings: Settings,
  options: {
    suggested?: ScoredSkill[];
    loadedBodies?: Array<{ name: string; body: string }>;
    projectInstruction?: string;
    expertInstruction?: string;
    /** Top-N recent pin texts. Empty / omitted = no memory block. */
    memoryPins?: string[];
  } = {},
): Promise<string> {
  const {
    suggested = [],
    loadedBodies = [],
    projectInstruction,
    expertInstruction,
    memoryPins,
  } = options;
  const skillLines =
    suggested.length === 0
      ? "- (keyword match will be added per user turn; list_skills to see all)"
      : suggested
          .map((s) => `- ${s.name}: ${s.description} (matched: ${s.reasons.join(", ")})`)
          .join("\n");

  const loaded =
    loadedBodies.length === 0
      ? ""
      : [
          "",
          "Auto-loaded skill playbooks for this task (follow them):",
          ...loadedBodies.map((s) => `### ${s.name}\n${s.body}`),
        ].join("\n");

  const boundBlock = formatBoundInstructionBlock({ expertInstruction, projectInstruction });
  const memoryBlock = formatMemoryPinBlock(memoryPins ?? []);

  return [
    "你是 Pig Agent，帮助用户在工作区完成任务的智能助手。",
    "回复语言：默认使用简体中文，包括进度说明、计划步骤、审批理由、错误解释和最终总结。用户明确要求其他语言或翻译时遵从用户要求；代码、命令、路径和原始日志保留原文，并用中文解释。英文工具定义、技能内容和历史英文回复不代表用户要求切换语言。",
    "Your file tools execute in the configured workspace. File access is workspace-scoped; shell execution uses the configured native sandbox or explicit host mode described below. Model inference uses the configured provider.",
    "",
    "工作方式（非简单任务）：",
    "1. 计划：改文件前调用 update_plan，列出具体、有序的步骤。",
    "2. 执行：用 list_dir / search_files / read_file 调查，再用 write_file、edit_file、apply_patch、move_file 或 delete_file 修改。需要真实命令才用 run_shell；公网资料使用 http_fetch。",
    "3. 验证：重新读取或搜索以确认修改生效。工具失败时不要重复相同调用，应换路径、缩小改动或报告阻塞原因。",
    "4. 交付：留下可审阅文件，并向用户总结新建、修改、移动、删除的路径和待核对事项。不能以工具调用代替最终回复。",
    "",
    "Hard rules:",
    "- Stay inside the configured workspace. Treat sandbox errors as final for that path.",
    "- Preserve the user's requested destination. Desktop/Downloads/Documents mean the user's actual OS folders, NOT similarly named subfolders in the workspace, unless the user explicitly says otherwise.",
    "- If a requested destination is outside the workspace, or its location is uncertain, do not write a substitute file or use shell to bypass the boundary. Explain the exact requested location and current workspace, ask the user to change Settings → 工作区根目录 or explicitly choose an in-workspace destination, and stop without claiming success.",
    "- Do not claim that host shell processes are isolated by Docker or an OS sandbox. Workspace access is a policy/file-tool boundary, not full host isolation.",
    "- Shell HOME is intentionally set to the workspace; it is not the user's actual home directory. Do not infer the user's real Desktop from shell ~ or $HOME.",
    "- For file delivery, state the actual absolute destination and verification performed. Never mark an unresolved destination request as completed.",
    "- Prefer small, reviewable edits (edit_file / apply_patch) over huge rewrites.",
    "- Do not invent file contents you did not read.",
    "- Reply in the user's language (Chinese if they wrote in Chinese).",
    "- If you already auto-loaded a skill below, follow it; otherwise list_skills / load_skill when a playbook matches.",
    "- run_shell: prefer simple commands (ls, rg, mkdir, python). Exit codes are in the JSON result — a non-zero exit is data, not always fatal.",
    "- http_fetch is SSRF-safe: private IPs and redirects are blocked.",
    "",
    `Workspace root: ${settings.workspaceRoot}`,
    `LLM: ${settings.llmModel} @ ${settings.llmBaseUrl}`,
    "",
    ...(boundBlock ? [boundBlock, ""] : []),
    ...(memoryBlock ? [memoryBlock, ""] : []),
    "Suggested skills for this task:",
    skillLines,
    loaded,
    "沟通要求：进度短句也默认使用简体中文，例如「我会申请访问这个网页，等待你批准后读取」。不要受英文工具定义影响写成英文。用户明确指定其他语言时除外。",
  ].join("\n");
}

export async function runAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  projectInstruction?: string;
  expertInstruction?: string;
  preferredSkillIds?: string[];
  /** Override pin injection (tests). Default: load recent in-scope pins. */
  memoryPins?: string[];
  /** Remote control-plane gate; runs before any mutation and may wait for a durable decision. */
  allowComputer?: boolean;
  networkFetch?: (args: Record<string, unknown>, callId: string) => Promise<string>;
  authorizeTool?: (call: { callId: string; tool: string; args: unknown }) => Promise<boolean>;
  mcpInvoke?: (call: { name: string; args: Record<string, unknown>; signal: AbortSignal; callId: string }) => Promise<string>;
  /** When false, ordinary mutations skip authorizeTool. MCP tools still use it. */
  authorizeMutations?: boolean;
  mcpTools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
}): Promise<Session> {
  const { settings, signal, emit, projectInstruction, expertInstruction, preferredSkillIds } = options;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    localRetry: undefined,
    updatedAt: nowIso(),
  };
  emit({ type: "status", status: "running" });
  const sandboxStarted = performance.now();
  void measureSandbox().then((status) => {
    recordDebugSpan({
      id: `sandbox:${session.id}`,
      sessionId: session.id,
      kind: "sandbox",
      name: "probe",
      status: status.available ? "ok" : "error",
      startedAtMs: 0,
      durationMs: Math.max(0, Math.round(performance.now() - sandboxStarted)),
      detail: {
        sandboxRequested: "native",
        sandboxEffective: "未采集",
        probeBackend: status.available ? status.backend : "未采集",
        available: status.available,
        error: status.error,
        note: "这是启动前的能力探测，不是某次工具的执行结果",
      },
    }, sandboxStarted);
  }).catch((err: unknown) => {
    recordDebugSpan({
      id: `sandbox:${session.id}`,
      sessionId: session.id,
      kind: "sandbox",
      name: "sandbox",
      status: "error",
      startedAtMs: 0,
      detail: { sandboxEffective: "未采集", error: err instanceof Error ? err.message : String(err), measured: false },
    }, sandboxStarted);
  });
  const workbench = session.deliveryMode ? await loadWorkbench(session.id, settings.workspaceRoot) : undefined;
  if (workbench && workbench.root !== normalizeWorkspaceRoot(settings.workspaceRoot)) throw new Error("工作区已改变。请切回任务原工作区，或新建任务。原位置：" + workbench.root);
  if (workbench?.operations.some((op) => op.status === "pending" || op.status === "applying" || op.status === "error")) throw new Error("请先处理待批准的变更；执行中断的操作需要核对，不能自动重放。");
  if (workbench) await saveWorkbench(session.id, workbench);

  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
  if (workbench?.checkpoint?.stopped) {
    if (workbench.checkpoint.userMessageId === lastUser?.id) throw new Error("本轮已拒绝或取消，请发送新的指令后再执行。");
    delete workbench.checkpoint; await saveWorkbench(session.id, workbench);
  }
  if (workbench?.checkpoint) {
    const applied = new Set(workbench.operations.filter((op) => op.status === "applied").map((op) => op.callId));
    for (const op of workbench.operations) if (applied.has(op.callId) && !session.messages.some((m) => m.toolCallId === op.callId)) {
      session.messages.push({ id: newId("msg"), role: "tool", toolCallId: op.callId, toolOk: true, content: `applied: ${op.output ?? "已执行"}`, createdAt: nowIso() });
    }
    workbench.checkpoint.calls = workbench.checkpoint.calls.filter((call) => !applied.has(call.id));
    await saveWorkbench(session.id, workbench);
  }
  const { suggested, loaded } = await loadSuggestedSkills(lastUser?.content ?? "");
  const loadedBodies = loaded.map((s) => ({ name: s.name, body: s.body }));
  const seenSkills = new Set(loadedBodies.map((s) => s.name));
  for (const skillId of preferredSkillIds ?? []) {
    if (seenSkills.has(skillId)) continue;
    try {
      const skill = await loadSkill(skillId);
      loadedBodies.push({ name: skill.name, body: skill.body });
      seenSkills.add(skill.name);
    } catch {
      // unknown local skill id — skip
    }
  }

  const system: ChatMessage = {
    id: newId("msg"),
    role: "system",
    content: await buildSystemPrompt(settings, {
      suggested,
      loadedBodies,
      projectInstruction,
      expertInstruction,
      memoryPins:
        options.memoryPins ??
        (await listRecentPinTexts({
          sessionId: session.id,
          projectId: session.projectId,
        })),
    }),
    createdAt: nowIso(),
  };

  if (workbench) system.content += `\nExecution mode: native sandbox, Codex-style on-request approval. File tools and shell commands stay inside the operating-system sandbox for ${workbench.root}. The command denylist is an extra refusal, not the isolation boundary. Writes and shell calls ${workbench.policy.review ? "are queued for user review; a queued operation is NOT executed. Stop and wait for approval" : "run immediately inside the sandbox. Do not ask before ordinary workspace edits or commands."}`;

  if (workbench) system.content += "\nHTTP requests always require a one-time review, independent of write review. http_fetch connects only to addresses checked before the request and does not follow redirects. Shell networking follows the task network switch and stays inside the sandbox.";

  const artifacts = new Map<string, Artifact>(
    session.artifacts.map((a) => [a.path, a]),
  );

  const allowComputer = options.allowComputer !== false && hasComputerBridge() && settings.runtime === "pig" && session.executionTarget !== "remote" && !options.authorizeTool;
  if (allowComputer) system.content += "\nComputer use is an optional desktop-only capability, separate from workspace tools. Each observation or input requires native user confirmation. Use accessibility text and bounds, never guess screen content; re-observe after input. It is unavailable until enabled in Settings → Computer use. Never use it to evade workspace or authorization restrictions.";
  const ctx: ToolContext = {
    workspaceRoot: settings.workspaceRoot,
    shellMode: workbench?.policy.shell,
    dockerImage: workbench?.policy.image,
    dockerNetwork: workbench?.policy.network,
    artifacts: session.artifacts,
    signal,
    recordArtifact: (path, action, extra) => {
      const artifact: Artifact = {
        path,
        action,
        updatedAt: nowIso(),
        ...extra,
      };
      artifacts.set(path, artifact);
      session.artifacts = [...artifacts.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      emit({ type: "artifact", artifact });
    },
  };

  let consecutiveErrors = 0;
  let forceSummary = false;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (signal.aborted) throw new Error("Aborted");

      const checkpoint = workbench?.checkpoint;
      const resuming = checkpoint && !checkpoint.stopped;
      let response: { content: string; toolCalls: Awaited<ReturnType<typeof complete>>["toolCalls"]; reasoningContent?: string; finishReason: string | null; request?: Awaited<ReturnType<typeof complete>>["request"] };
      if (resuming && checkpoint.calls.length) {
        response = { content: "", toolCalls: checkpoint.calls, finishReason: null };
      } else {
      if (workbench?.checkpoint) { delete workbench.checkpoint; await saveWorkbench(session.id, workbench); }
      const history = trimHistory([system, ...session.messages]);
      if (forceSummary) {
        history.push({
          id: newId("msg"),
          role: "user",
          content:
            "[harness] Stop calling tools. Write a concise user-facing summary of what you already changed, what failed, and what to review.",
          createdAt: nowIso(),
        });
      }

      const inputEstimate = history.reduce((n, m) => n + m.content.length + (m.reasoningContent?.length ?? 0) + JSON.stringify(m.toolCalls ?? []).length, 0) + JSON.stringify(TOOL_DEFINITIONS).length;
      let remaining = workbench ? workbench.policy.maxTokens - workbench.usage.input - workbench.usage.output - inputEstimate : 4096;
      if (workbench && workbench.policy.maxCost > 0) {
        const moneyLeft = workbench.policy.maxCost - workbench.usage.cost - inputEstimate * workbench.policy.inputPrice / 1000000;
        if (moneyLeft <= 0) remaining = 0;
        else if (workbench.policy.outputPrice > 0) remaining = Math.min(remaining, Math.floor(moneyLeft * 1000000 / workbench.policy.outputPrice));
      }
      if (workbench && (workbench.usage.calls >= workbench.policy.maxCalls || remaining < 128)) throw new Error("任务预算已到上限。请在执行设置中增加调用或 token 预算后继续。");
      let reported: { prompt_tokens: number; completion_tokens: number } | undefined;
      const modelStarted = Date.now();
      if (workbench) { workbench.usage.calls++; await saveWorkbench(session.id, workbench); }
      const modelStartedMono = performance.now();
      const modelSpanId = newId("span");
      let firstTokenAt: number | undefined;
      recordDebugSpan({
        id: modelSpanId,
        sessionId: session.id,
        turnId: String(turn),
        kind: "model",
        name: settings.llmModel || "model",
        status: "running",
        startedAtMs: 0,
        wallStartedAt: new Date(modelStarted).toISOString(),
        detail: { model: settings.llmModel, provider: providerHost(settings.llmBaseUrl), sandboxEffective: "未采集", usage: null, finishReason: null, ttftMs: null },
      }, modelStartedMono);
      response = await complete(settings, history, {
        signal,
        extraTools: allowComputer || options.mcpTools?.length
          ? [...(allowComputer ? [computerToolDefinition] : []), ...(options.mcpTools ?? [])]
          : undefined,
        maxOutputTokens: workbench ? Math.min(4096, remaining) : undefined,
        onUsage: (usage) => { reported = usage; },
        onDelta: (text) => {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          emit({ type: "token", text });
        },
      }).catch(async (err) => {
        if (workbench) {
          const reservedOutput = Math.min(4096, remaining);
          workbench.usage.input += inputEstimate;
          workbench.usage.output += reservedOutput;
          workbench.usage.estimated = true;
          workbench.usage.durationMs += Date.now() - modelStarted;
          workbench.usage.cost += (inputEstimate * workbench.policy.inputPrice + reservedOutput * workbench.policy.outputPrice) / 1000000;
          await saveWorkbench(session.id, workbench);
        }
        recordDebugSpan({
          id: modelSpanId,
          sessionId: session.id,
          turnId: String(turn),
          kind: "model",
          name: settings.llmModel || "model",
          status: signal.aborted ? "cancelled" : "error",
          startedAtMs: 0,
          durationMs: Math.max(0, Math.round(performance.now() - modelStartedMono)),
          wallStartedAt: new Date(modelStarted).toISOString(),
          detail: debugDetail(session.id, {
            error: err instanceof Error ? err.message : String(err),
            sandboxEffective: "未采集",
            usage: reported ?? null,
            finishReason: null,
            ttftMs: firstTokenAt === undefined ? null : Math.max(0, Math.round(firstTokenAt - modelStartedMono)),
          }, {
            request: requestFrom(err),
          }),
        }, modelStartedMono);
        throw err;
      });
      recordDebugSpan({
        id: modelSpanId,
        sessionId: session.id,
        turnId: String(turn),
        kind: "model",
        name: settings.llmModel || "model",
        status: "ok",
        startedAtMs: 0,
        durationMs: Math.max(0, Math.round(performance.now() - modelStartedMono)),
        wallStartedAt: new Date(modelStarted).toISOString(),
        detail: debugDetail(session.id, {
          model: settings.llmModel,
          provider: providerHost(settings.llmBaseUrl),
          sandboxRequested: workbench?.policy.shell ?? "未采集",
          sandboxEffective: "未采集",
          usage: reported ?? null,
          finishReason: response.finishReason,
          ttftMs: firstTokenAt === undefined ? null : Math.max(0, Math.round(firstTokenAt - modelStartedMono)),
        }, {
          request: response.request,
          response: response.content,
          toolCalls: response.toolCalls,
        }),
      }, modelStartedMono);

      const { content, toolCalls } = response;
      if (workbench) {
        const valid = reported && Number.isFinite(reported.prompt_tokens) && Number.isFinite(reported.completion_tokens) && reported.prompt_tokens >= 0 && reported.completion_tokens >= 0;
        const input = valid ? reported!.prompt_tokens : inputEstimate;
        const output = valid ? reported!.completion_tokens : content.length + JSON.stringify(toolCalls).length;
        workbench.usage.input += input;
        workbench.usage.output += output;
        workbench.usage.estimated ||= !valid;
        workbench.usage.durationMs += Date.now() - modelStarted;
        workbench.usage.cost += (input * workbench.policy.inputPrice + output * workbench.policy.outputPrice) / 1000000;
        await saveWorkbench(session.id, workbench);
      }
      }
      const { content, toolCalls, reasoningContent } = response;
      if (!resuming || !checkpoint?.calls.length) {
      const assistant: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        content,
        reasoningContent: reasoningContent ?? "",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        createdAt: nowIso(),
      };
      session.messages.push(assistant);
      emit({ type: "message", message: assistant });

      if (toolCalls.length === 0 || forceSummary) {
        if (!content.trim() && session.artifacts.length > 0) {
          const fallback = deliverableSummary(session, "模型未返回最终说明。已有产物如下，请根据验收清单核对；不能据此确认任务完成。");
          const extra: ChatMessage = {
            id: newId("msg"),
            role: "assistant",
            content: fallback,
            createdAt: nowIso(),
          };
          session.messages.push(extra);
          emit({ type: "message", message: extra });
        }
        return finishIdle(session, emit);
      }

      }
      let turnHadError = false;
      let awaitingReview = false;
      if (workbench) await saveSession(session);
      const readonlyTools = new Set(["read_file", "list_dir", "search_files", "list_skills"]);
      const readonlyWindow = !workbench && !options.authorizeTool && toolCalls.length > 1 && toolCalls.every((call) => readonlyTools.has(call.name))
        ? createReadonlyWindow(toolCalls, ctx, signal)
        : undefined;
      for (const [callIndex, call] of toolCalls.entries()) {
        if (signal.aborted) throw new Error("Aborted");
        if (forceSummary) break;
        const parsed = safeJsonParse(call.arguments);
        const startedAt = nowIso();
        const t0 = Date.now();
        emit({
          type: "tool_start",
          id: call.id,
          name: call.name,
          arguments: parsed,
          startedAt,
        });

        if (call.name === "update_plan") {
          const steps = parsePlan(parsed);
          session.steps = steps;
          emit({ type: "steps", steps });
        } else {
          markToolStep(session, call.name, "running", summarizeToolArgs(parsed));
          emit({ type: "steps", steps: session.steps });
        }

        if (workbench) {
          workbench.checkpoint = { calls: toolCalls.slice(callIndex), userMessageId: lastUser?.id };
          await saveWorkbench(session.id, workbench);
        }
        let output = "";
        let ok = true;
        const prepared = readonlyWindow?.has(call.id) ? await readonlyWindow.take(call.id) : undefined;
        if (readonlyWindow && !signal.aborted) readonlyWindow.fill();
        const toolStarted = prepared?.startedAt ?? performance.now();
        let sandboxFact: ToolSandboxFact = {
          requested: workbench?.policy.shell ?? ctx.shellMode ?? "未采集",
          effective: "尚未执行",
          backend: "未采集",
        };
        if (options.authorizeTool && (parseMcpToolName(call.name) || (MUTATIONS.has(call.name) && options.authorizeMutations !== false))) {
          const approvalId = `${call.id}:approval`;
          const finishApproval = (status: "running" | "ok" | "cancelled" | "error", error?: string) => {
            recordDebugSpan({
              id: approvalId,
              sessionId: session.id,
              kind: "approval",
              name: call.name,
              status,
              startedAtMs: 0,
              durationMs: status === "running" ? undefined : Math.max(0, Math.round(performance.now() - toolStarted)),
              detail: {
                sandboxRequested: sandboxFact.requested,
                sandboxEffective: "尚未执行",
                sandboxBackend: "未采集",
                ...(error ? { error } : {}),
              },
            }, toolStarted);
          };
          finishApproval("running");
          let approvalFailure: Error | undefined;
          try {
            const approved = await options.authorizeTool({ callId: call.id, tool: call.name, args: parsed });
            if (signal.aborted) throw new Error("Aborted");
            if (!approved) throw new Error("用户拒绝了远端操作，本次操作未执行");
          } catch (err) {
            approvalFailure = err instanceof Error ? err : new Error(String(err));
          }
          const denied = approvalFailure?.message.includes("用户拒绝") === true;
          const approvalStatus = !approvalFailure ? "ok" : signal.aborted || approvalFailure.message === "Aborted" || denied ? "cancelled" : "error";
          finishApproval(approvalStatus, approvalFailure?.message);
          if (approvalFailure) throw approvalFailure;
        }
        if (call.name !== "update_plan") {
          recordDebugSpan({
            id: call.id,
            sessionId: session.id,
            kind: "tool",
            name: call.name,
            status: "running",
            startedAtMs: 0,
            detail: { sandboxRequested: sandboxFact.requested, sandboxEffective: "尚未执行", sandboxBackend: "未采集" },
          }, toolStarted);
        }
        try {
          if (call.name === "http_fetch" && options.networkFetch) {
            output = await options.networkFetch(parsed as Record<string, unknown>, call.id);
          } else if (call.name === "computer_use") {
            if (!allowComputer) throw Error("电脑操作只允许在桌面本机 Pig 任务中使用");
            if (awaitingReview) throw Error("请先处理待批准操作");
            output = await executeComputerTool(parsed as Record<string, unknown>, signal);
          } else if (workbench && call.name === "http_fetch") {
            const op = await stageOperation(workbench, call.id, call.name, parsed as Record<string, unknown>);
            await saveWorkbench(session.id, workbench);
            awaitingReview = true;
            output = `单次网络访问待批准，尚未访问目标。变更单 ${op.id}；GET ${String((parsed as Record<string, unknown>).url || "")}。该授权仅对应这次读取，不开启 Shell 网络。请先处理审批。`;
          } else if (workbench && MUTATIONS.has(call.name)) {
            const op = await stageOperation(workbench, call.id, call.name, parsed as Record<string, unknown>);
            await saveWorkbench(session.id, workbench);
            if (workbench.policy.review) {
              awaitingReview = true;
              output = `待批准，尚未执行。变更单 ${op.id}；目标工作区 ${op.root}；环境 ${op.environment}。请在执行与验收中审阅。`;
            } else {
              const applied = await applyOperation(session.id, workbench, op, signal);
              output = applied.output ?? "已执行";
              sandboxFact = (applied as { sandbox?: ToolSandboxFact }).sandbox ?? { requested: op.environment, effective: "未采集", backend: "未采集" };
              for (const artifact of op.artifacts ?? []) ctx.recordArtifact(artifact.path, artifact.action, artifact);
            }
          } else if (awaitingReview && call.name !== "update_plan") {
            output = "前序变更等待批准，本工具未执行。批准后继续任务。";
          } else if (parseMcpToolName(call.name)) {
            if (signal.aborted) throw new Error("Aborted");
            if (!options.authorizeTool && !workbench) throw new Error("外部 MCP 工具必须经过审批，本次未调用");
            if (!options.authorizeTool && workbench) {
              const op = await stageOperation(workbench, call.id, call.name, parsed as Record<string, unknown>);
              op.mcpTarget = await requireMcpTarget(call.name);
              await saveWorkbench(session.id, workbench);
              awaitingReview = true;
              output = `外部 MCP 调用待批准，尚未连接服务器。变更单 ${op.id}。服务器 ${op.mcpTarget.url}，工具 ${call.name}，输入 ${JSON.stringify(parsed).slice(0, 500)}。远端服务不在本机沙箱内，批准后才会调用一次。`;
            } else {
              if (!options.mcpInvoke) throw new Error("外部 MCP 工具尚未配置，本次未调用");
              output = await options.mcpInvoke({ name: call.name, args: parsed as Record<string, unknown>, signal, callId: call.id });
              sandboxFact = { requested: "mcp", effective: "远端 MCP 服务", backend: "mcp-http" };
            }
          } else if (prepared) {
            if (!prepared.ok) throw prepared.error;
            output = prepared.value.output;
            if (prepared.value.sandbox) sandboxFact = prepared.value.sandbox;
          } else {
            const result = await executeTool(call.name, parsed, ctx);
            output = result.output;
            if (result.sandbox) sandboxFact = result.sandbox;
          }
          if (call.name !== "update_plan") {
            markToolStep(session, call.name, awaitingReview ? "pending" : "done", output.slice(0, 180));
            emit({ type: "steps", steps: session.steps });
          }
        } catch (err) {
          if (err instanceof ToolAuthorizationDenied) {
            recordDebugSpan({
              id: call.id,
              sessionId: session.id,
              kind: "approval",
              name: call.name,
              status: "cancelled",
              startedAtMs: 0,
              durationMs: Math.max(0, Math.round(performance.now() - toolStarted)),
              detail: { error: err.message, sandboxRequested: sandboxFact.requested, sandboxEffective: "尚未执行", sandboxBackend: "未采集" },
            }, toolStarted);
            throw err;
          }
          ok = false;
          const failedOp = workbench?.operations.find((op) => op.callId === call.id) as { sandbox?: ToolSandboxFact } | undefined;
          sandboxFact = failedOp?.sandbox ?? sandboxFromError(err) ?? sandboxFact;
          if (workbench?.operations.some((op) => op.callId === call.id && op.status === "error")) awaitingReview = true;
          turnHadError = true;
          output = err instanceof Error ? err.message : String(err);
          if (err instanceof SandboxError) {
            output = `Sandbox blocked this call: ${output}`;
          }
          markToolStep(session, call.name, "error", output);
          emit({ type: "steps", steps: session.steps });
        }
        const elapsedMs = prepared
          ? Math.max(0, Math.round(prepared.finishedAt - prepared.startedAt))
          : Math.max(0, Math.round(performance.now() - toolStarted));
        if (call.name !== "update_plan") {
          recordDebugSpan({
            id: call.id,
            sessionId: session.id,
            kind: awaitingReview ? "approval" : "tool",
            name: call.name,
            status: signal.aborted ? "cancelled" : !ok ? "error" : awaitingReview ? "running" : "ok",
            startedAtMs: 0,
            durationMs: elapsedMs,
            detail: debugDetail(session.id, {
              sandboxRequested: sandboxFact.requested,
              sandboxEffective: sandboxFact.effective,
              sandboxBackend: sandboxFact.backend,
              network: workbench?.policy.network ?? false,
            }, {
              arguments: parsed,
              output,
            }),
          }, toolStarted);
        }

        if (awaitingReview && workbench?.operations.some((op) => op.callId === call.id && op.status === "pending")) {
          workbench.checkpoint = { calls: toolCalls.slice(callIndex + 1), blockedCallId: call.id, userMessageId: lastUser?.id };
          await saveWorkbench(session.id, workbench);
          await saveSession(session);
          break;
        }
        if (workbench) {
          workbench.checkpoint = { calls: toolCalls.slice(callIndex + 1), userMessageId: lastUser?.id };
          await saveWorkbench(session.id, workbench);
        }
        const durationMs = prepared ? elapsedMs : Date.now() - t0;
        const toolMsg: ChatMessage = {
          id: newId("msg"),
          role: "tool",
          content: output,
          toolCallId: call.id,
          toolOk: ok,
          toolDurationMs: durationMs,
          createdAt: nowIso(),
        };
        session.messages.push(toolMsg);
        emit({ type: "tool_end", id: call.id, name: call.name, ok, output, durationMs });
        emit({ type: "message", message: toolMsg });
        if (workbench) await saveSession(session);
        if (awaitingReview) break;
      }

      if (awaitingReview) {
        const notice: ChatMessage = { id: newId("msg"), role: "assistant", content: workbench?.operations.some((op) => op.status === "error") ? "变更执行异常，可能已有部分影响。请在「执行与验收」核对文件与执行记录，确认后再继续。" : "已准备好变更预览，尚未执行。请打开「执行与验收」核对目标路径、差异或命令，批准后将从当前操作继续，一次只执行一项审批。", createdAt: nowIso() };
        // A pending call has no tool result yet. Keep the provider transcript open;
        // inserting an assistant notice here would split the tool-call/result protocol.
        if (workbench?.operations.some((op) => op.status === "error")) { session.lastError = notice.content; emit({ type: "error", message: notice.content }); }
        return finishIdle(session, emit);
      }
      if (turnHadError) {
        consecutiveErrors += 1;
        session.messages.push({
          id: newId("msg"),
          role: "user",
          content:
            consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
              ? "[harness] Multiple tools failed in a row. Do not retry the same call. Recover with a different approach or summarize the blocker for the user."
              : "[harness] A tool failed. Read the error, try a different approach (search, smaller edit, another path). Then continue or explain.",
          createdAt: nowIso(),
        });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          forceSummary = true;
          session.lastError = LOCAL_TURN_MESSAGES.tool_failed;
          session.localRetry = decideLocalRetry(session);
          emit({ type: "error", message: session.lastError });
        }
      } else {
        consecutiveErrors = 0;
      }
    }

    const overflow: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      content: deliverableSummary(
        session,
        "已达到本轮最大工具步数。如需继续，请再发一条消息。",
      ),
      createdAt: nowIso(),
    };
    session.messages.push(overflow);
    emit({ type: "message", message: overflow });
    return finishIdle(session, emit);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const aborted = raw === "Aborted" || signal.aborted;
    if (aborted) {
      if (workbench) {
        workbench.checkpoint = { calls: [], userMessageId: lastUser?.id, stopped: true };
        await saveWorkbench(session.id, workbench);
      }
      cancelRunningDebugSpans(session.id, "已取消");
      const stop: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        content: deliverableSummary(session, "已停止。已完成的步骤和产物仍可在右侧审阅。"),
        createdAt: nowIso(),
      };
      session.messages.push(stop);
      emit({ type: "message", message: stop });
      session.status = "idle";
      session.lastError = undefined;
      session.localRetry = undefined;
    } else {
      // Recoverable idle + banner — session must not stick in running.
      session.status = "idle";
      session.lastError = formatLocalTurnError(err);
      session.localRetry = decideLocalRetry(session);
      session.remoteRetry = undefined;
      emit({ type: "error", message: session.lastError });
    }
    session.updatedAt = nowIso();
    settleUnfinishedSteps(session, emit);
    emit({ type: "status", status: session.status });
    emit({ type: "done", session });
    return session;
  }
}

function finishIdle(session: Session, emit: (event: AgentEvent) => void): Session {
  session.status = "idle";
  session.updatedAt = nowIso();
  settleUnfinishedSteps(session, emit);
  emit({ type: "status", status: "idle" });
  emit({ type: "done", session });
  return session;
}

/** A finished turn is not proof that every planned task succeeded. */
function settleUnfinishedSteps(session: Session, emit: (event: AgentEvent) => void): void {
  if (!session.steps.some((step) => step.status === "running")) return;
  session.steps = session.steps.map((step) => step.status === "running"
    ? { ...step, status: "pending" as const }
    : step);
  emit({ type: "steps", steps: session.steps });
}

export function deliverableSummary(session: Session, lead: string): string {
  const groups = {
    created: session.artifacts.filter((a) => a.action === "created").map((a) => a.path),
    modified: session.artifacts.filter((a) => a.action === "modified").map((a) => a.path),
    moved: session.artifacts
      .filter((a) => a.action === "moved")
      .map((a) => (a.fromPath ? `${a.fromPath} → ${a.path}` : a.path)),
    deleted: session.artifacts.filter((a) => a.action === "deleted").map((a) => a.path),
  };
  const lines = [lead, ""];
  if (groups.created.length) lines.push(`新建：${groups.created.join(", ")}`);
  if (groups.modified.length) lines.push(`修改：${groups.modified.join(", ")}`);
  if (groups.moved.length) lines.push(`移动：${groups.moved.join(", ")}`);
  if (groups.deleted.length) lines.push(`删除：${groups.deleted.join(", ")}`);
  if (
    !groups.created.length &&
    !groups.modified.length &&
    !groups.moved.length &&
    !groups.deleted.length
  ) {
    lines.push("本轮没有写入产物。");
  } else {
    lines.push("", "请在右侧「产物」中打开文件核对。");
  }
  return lines.join("\n").trim();
}

const READONLY_PARALLEL = 3;
const CONTEXT_NOTE_BUDGET = 4_000;

function createReadonlyWindow(
  calls: Array<{ id: string; name: string; arguments: string }>,
  ctx: Parameters<typeof executeTool>[2],
  signal: AbortSignal,
) {
  const slots = new Map<string, { startedAt: number; pending: Promise<{ ok: true; value: Awaited<ReturnType<typeof executeTool>>; finishedAt: number } | { ok: false; error: unknown; finishedAt: number }> }>();
  let cursor = 0;
  const launch = (call: { id: string; name: string; arguments: string }) => {
    const startedAt = performance.now();
    const pending = executeTool(call.name, safeJsonParse(call.arguments), ctx).then(
      (value) => ({ ok: true as const, value, finishedAt: performance.now() }),
      (error: unknown) => ({ ok: false as const, error, finishedAt: performance.now() }),
    );
    slots.set(call.id, { startedAt, pending });
  };
  const fill = () => {
    while (!signal.aborted && slots.size < READONLY_PARALLEL && cursor < calls.length) {
      const call = calls[cursor];
      cursor += 1;
      if (call) launch(call);
    }
  };
  fill();
  return {
    has(id: string) { return slots.has(id); },
    fill,
    async take(id: string) {
      const slot = slots.get(id);
      if (!slot) return undefined;
      const settled = await slot.pending;
      slots.delete(id);
      return { ...settled, startedAt: slot.startedAt };
    },
  };
}

function historySize(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0);
}

function repairMessages(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const ids = message.toolCalls.map((call) => call.id);
      const results: ChatMessage[] = [];
      let cursor = index + 1;
      const pending = new Set(ids);
      while (cursor < messages.length && messages[cursor]?.role === "tool" && messages[cursor]?.toolCallId && pending.has(messages[cursor]!.toolCallId!)) {
        const result = messages[cursor];
        if (!result?.toolCallId) break;
        pending.delete(result.toolCallId);
        results.push(result);
        cursor += 1;
      }
      if (pending.size === 0) {
        kept.push(message, ...results);
        index = cursor - 1;
      } else if (message.content.trim()) {
        kept.push({ ...message, toolCalls: undefined });
      }
      continue;
    }
    if (message.role === "tool") continue;
    kept.push({ ...message, toolCalls: undefined });
  }
  return kept;
}

function contextNote(rest: ChatMessage[]): ChatMessage | undefined {
  const facts: string[] = [];
  const goal = rest.find((message) => message.role === "user" && !message.content.startsWith("[harness]"));
  if (goal?.content.trim()) facts.push(goal.content.slice(0, 1500));
  const results = new Map(rest.filter((message) => message.role === "tool" && message.toolCallId).map((message) => [message.toolCallId, message]));
  for (const message of rest) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      const result = results.get(call.id);
      if (!result) continue;
      if (call.name === "update_plan") facts.push(call.arguments.slice(0, 800));
      if (/约束|待办|批准|已批准|applied:/.test(`${call.arguments}\n${result.content}`)) facts.push(result.content.slice(0, 800));
    }
  }
  let body = "";
  for (const fact of facts) {
    const next = body ? `${body}\n${fact}` : fact;
    if (next.length > CONTEXT_NOTE_BUDGET) break;
    body = next;
  }
  if (!body) return undefined;
  return {
    id: "history-note",
    role: "user",
    content: `较早的工具输出已省略。保留的目标、约束、审批和待办：\n${body}`,
    createdAt: goal?.createdAt ?? nowIso(),
  };
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const [system, ...rest] = messages;
  if (!system) return messages;
  const note = contextNote(rest);
  // Bound individual results before dropping message groups. A single large web
  // page must not erase its own call/result and make the model request it again.
  // These are model-input copies; the persisted transcript retains full output.
  let kept = repairMessages(rest.map(message => message.role === "tool" && message.content.length > 16000
    ? {...message, content: message.content.slice(0, 12000) + "\n[工具结果已截断：中间部分省略；完整内容保存在任务记录中。请基于已返回的结果继续，勿仅因截断重复执行。]\n" + message.content.slice(-4000)}
    : message));
  while (kept.length > 4 && historySize(kept) + (note?.content.length ?? 0) > MAX_HISTORY_CHARS) {
    kept = repairMessages(kept.slice(1));
  }
  while (kept.length > 1 && historySize(kept) + (note?.content.length ?? 0) > MAX_HISTORY_CHARS) {
    kept = repairMessages(kept.slice(1));
  }
  const visible = `${kept.map((message) => `${message.content}\n${JSON.stringify(message.toolCalls ?? [])}`).join("\n")}`;
  const needed = note && !note.content.split("\n").slice(1).every((line) => line.length < 12 || visible.includes(line.slice(0, 24)));
  let combined = needed && note ? [note, ...kept] : kept;
  while (combined.length > 1 && historySize(combined) > MAX_HISTORY_CHARS) {
    combined = combined[0]?.id === "history-note"
      ? [combined[0], ...repairMessages(combined.slice(2))]
      : repairMessages(combined.slice(1));
  }
  if (combined[0]?.id === "history-note" && historySize(combined) > MAX_HISTORY_CHARS) {
    const room = Math.max(0, MAX_HISTORY_CHARS - historySize(combined.slice(1)));
    combined = [{ ...combined[0], content: combined[0].content.slice(0, room) }, ...combined.slice(1)];
  }
  return [system, ...combined];
}

function parsePlan(parsed: unknown): PlanStep[] {
  const obj = parsed && typeof parsed === "object" ? (parsed as { steps?: unknown }) : {};
  const steps = Array.isArray(obj.steps) ? obj.steps : [];
  return steps.map((raw, i) => {
    const step = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const status = step.status;
    return {
      id: newId("step"),
      title: String(step.title ?? `Step ${i + 1}`),
      status:
        status === "running" || status === "done" || status === "error" || status === "pending"
          ? status
          : "pending",
      detail: typeof step.detail === "string" ? step.detail : undefined,
    };
  });
}

function markToolStep(
  session: Session,
  toolName: string,
  status: PlanStep["status"],
  detail?: string,
): void {
  const title = toolLabel(toolName);
  const existing = [...session.steps]
    .reverse()
    .find((s) => s.title === title && (s.status === "running" || s.status === "pending"));
  if (existing) {
    existing.status = status;
    existing.detail = detail;
    return;
  }
  session.steps = [...session.steps, { id: newId("step"), title, status, detail }];
}

export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    update_plan: "更新计划",
    list_dir: "查看目录",
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "编辑文件",
    apply_patch: "应用补丁",
    search_files: "搜索文件",
    delete_file: "删除文件",
    move_file: "移动文件",
    run_shell: "运行命令",
    http_fetch: "抓取网页",
    list_skills: "列出技能",
    load_skill: "加载技能",
  };
  return labels[name] ?? name;
}
