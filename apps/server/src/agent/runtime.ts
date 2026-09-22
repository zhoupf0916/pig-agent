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
import { loadSkill, loadSuggestedSkills, type ScoredSkill } from "./skills.ts";
import { executeTool, summarizeToolArgs, type ToolContext, TOOL_DEFINITIONS } from "./tools.ts";

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
    "You are Pig Agent, a local WorkBuddy-style workstation assistant.",
    "Your file tools execute in the configured workspace. File access is workspace-scoped; shell execution uses the configured native sandbox or explicit host mode described below. Model inference uses the configured provider.",
    "",
    "How you work (every non-trivial task):",
    "1. Plan — call update_plan with concrete, ordered steps before changing files.",
    "2. Tool — explore with list_dir / search_files / read_file. Then change files with write_file, edit_file, apply_patch, move_file, or delete_file. Use run_shell only when a real command is needed. Use http_fetch only for public research.",
    "3. Verify — re-read or search to confirm the change landed. If a tool fails, do not repeat the same call; recover with a different path, a smaller edit, or report the blocker.",
    "4. Deliver — leave reviewable artifacts on disk. After tools, you MUST write a clear user-facing summary: what changed, created vs modified vs moved vs deleted (paths), and what to review. Never finish with only tool calls.",
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
      let response: Awaited<ReturnType<typeof complete>>;
      if (resuming && checkpoint.calls.length) {
        response = { content: "", toolCalls: checkpoint.calls };
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
      response = await complete(settings, history, {
        signal,
        extraTools: allowComputer ? [computerToolDefinition] : undefined,
        maxOutputTokens: workbench ? Math.min(4096, remaining) : undefined,
        onUsage: workbench ? (usage) => { reported = usage; } : undefined,
        onDelta: (text) => emit({ type: "token", text }),
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
        throw err;
      });

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
        if (options.authorizeTool && MUTATIONS.has(call.name)) {
          const approved = await options.authorizeTool({ callId: call.id, tool: call.name, args: parsed });
          if (!approved) throw new Error("用户拒绝了远端操作，本次操作未执行");
          if (signal.aborted) throw new Error("Aborted");
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
              await applyOperation(session.id, workbench, op, signal);
              output = op.output ?? "已执行";
              for (const artifact of op.artifacts ?? []) ctx.recordArtifact(artifact.path, artifact.action, artifact);
            }
          } else if (awaitingReview && call.name !== "update_plan") {
            output = "前序变更等待批准，本工具未执行。批准后继续任务。";
          } else {
            const result = await executeTool(call.name, parsed, ctx);
            output = result.output;
          }
          if (call.name !== "update_plan") {
            markToolStep(session, call.name, awaitingReview ? "pending" : "done", output.slice(0, 180));
            emit({ type: "steps", steps: session.steps });
          }
        } catch (err) {
          if (err instanceof ToolAuthorizationDenied) throw err;
          ok = false;
          if (workbench?.operations.some((op) => op.callId === call.id && op.status === "error")) awaitingReview = true;
          turnHadError = true;
          output = err instanceof Error ? err.message : String(err);
          if (err instanceof SandboxError) {
            output = `Sandbox blocked this call: ${output}`;
          }
          markToolStep(session, call.name, "error", output);
          emit({ type: "steps", steps: session.steps });
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
        const durationMs = Date.now() - t0;
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

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const [system, ...rest] = messages;
  if (!system) return messages;
  let kept = [...rest];
  const size = () =>
    kept.reduce((n, m) => n + m.content.length + (m.reasoningContent?.length ?? 0) + JSON.stringify(m.toolCalls ?? []).length, 0);
  while (kept.length > 8 && size() > MAX_HISTORY_CHARS) {
    kept = kept.slice(2);
  }
  while (kept[0]?.role === "tool") kept = kept.slice(1);
  return [system, ...kept];
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
