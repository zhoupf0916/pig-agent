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
import { executeTool, summarizeToolArgs, type ToolContext } from "./tools.ts";

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
    "Your file tools execute in the configured workspace. The local Pig runtime uses host processes, not a Docker/VM sandbox. Model inference uses the configured provider.",
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

  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
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

  const artifacts = new Map<string, Artifact>(
    session.artifacts.map((a) => [a.path, a]),
  );

  const ctx: ToolContext = {
    workspaceRoot: settings.workspaceRoot,
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

      const { content, toolCalls } = await complete(settings, history, {
        signal,
        onDelta: (text) => emit({ type: "token", text }),
      });

      const assistant: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        createdAt: nowIso(),
      };
      session.messages.push(assistant);
      emit({ type: "message", message: assistant });

      if (toolCalls.length === 0 || forceSummary) {
        if (!content.trim() && session.artifacts.length > 0) {
          const fallback = deliverableSummary(session, "工作已完成。");
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

      let turnHadError = false;
      for (const call of toolCalls) {
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

        let output = "";
        let ok = true;
        try {
          const result = await executeTool(call.name, parsed, ctx);
          output = result.output;
          if (call.name !== "update_plan") {
            markToolStep(session, call.name, "done", output.slice(0, 180));
            emit({ type: "steps", steps: session.steps });
          }
        } catch (err) {
          ok = false;
          turnHadError = true;
          output = err instanceof Error ? err.message : String(err);
          if (err instanceof SandboxError) {
            output = `Sandbox blocked this call: ${output}`;
          }
          markToolStep(session, call.name, "error", output);
          emit({ type: "steps", steps: session.steps });
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
    kept.reduce((n, m) => n + m.content.length + (m.toolCalls?.length ?? 0) * 80, 0);
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
