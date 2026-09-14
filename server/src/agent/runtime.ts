import type {
  AgentEvent,
  Artifact,
  ChatMessage,
  PlanStep,
  Session,
  Settings,
} from "../types.ts";
import { newId, nowIso, safeJsonParse } from "../util.ts";
import { LlmError, complete } from "./openai.ts";
import { SandboxError } from "./sandbox.ts";
import { listSkills } from "./skills.ts";
import { executeTool, type ToolContext } from "./tools.ts";

const MAX_TURNS = 16;
const MAX_HISTORY_CHARS = 80_000;

export async function buildSystemPrompt(settings: Settings): Promise<string> {
  const skills = await listSkills();
  const skillLines =
    skills.length === 0
      ? "- (none installed)"
      : skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  return [
    "You are Pig Agent, a local workstation assistant that runs entirely on the user's machine.",
    "The user describes a work goal. You plan concrete steps, use tools on the sandboxed workspace, and leave reviewable files.",
    "",
    "Hard rules:",
    "- Only read/write/execute inside the configured workspace. Never try to leave it.",
    "- Prefer small, reviewable file changes over huge rewrites.",
    "- Call update_plan before you start work, and keep step statuses current.",
    "- When a skill matches the task, list_skills / load_skill and follow it.",
    "- After file changes, briefly tell the user what to review (paths).",
    "- Reply in the user's language (Chinese if they wrote in Chinese).",
    "- If a tool fails, explain and try a different approach. Do not invent file contents you did not read.",
    "",
    `Workspace root: ${settings.workspaceRoot}`,
    `LLM: ${settings.llmModel} @ ${settings.llmBaseUrl}`,
    "",
    "Available skills:",
    skillLines,
  ].join("\n");
}

export async function runAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}): Promise<Session> {
  const { settings, signal, emit } = options;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    updatedAt: nowIso(),
  };
  emit({ type: "status", status: "running" });

  const system: ChatMessage = {
    id: newId("msg"),
    role: "system",
    content: await buildSystemPrompt(settings),
    createdAt: nowIso(),
  };

  const artifacts = new Map<string, Artifact>(
    session.artifacts.map((a) => [a.path, a]),
  );

  const ctx: ToolContext = {
    workspaceRoot: settings.workspaceRoot,
    artifacts: session.artifacts,
    recordArtifact: (path, action) => {
      const artifact: Artifact = { path, action, updatedAt: nowIso() };
      artifacts.set(path, artifact);
      session.artifacts = [...artifacts.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      emit({ type: "artifact", artifact });
    },
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (signal.aborted) throw new Error("Aborted");

      const history = trimHistory([system, ...session.messages]);
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

      if (toolCalls.length === 0) {
        session.status = "idle";
        session.updatedAt = nowIso();
        emit({ type: "status", status: "idle" });
        emit({ type: "done", session });
        return session;
      }

      for (const call of toolCalls) {
        if (signal.aborted) throw new Error("Aborted");
        const parsed = safeJsonParse(call.arguments);
        emit({ type: "tool_start", id: call.id, name: call.name, arguments: parsed });

        if (call.name === "update_plan") {
          const steps = parsePlan(parsed);
          session.steps = steps;
          emit({ type: "steps", steps });
        } else {
          markToolStep(session, call.name, "running", summarizeArgs(parsed));
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
          output = err instanceof Error ? err.message : String(err);
          if (err instanceof SandboxError) {
            output = `Sandbox blocked this call: ${output}`;
          }
          markToolStep(session, call.name, "error", output);
          emit({ type: "steps", steps: session.steps });
        }

        const toolMsg: ChatMessage = {
          id: newId("msg"),
          role: "tool",
          content: output,
          toolCallId: call.id,
          createdAt: nowIso(),
        };
        session.messages.push(toolMsg);
        emit({ type: "tool_end", id: call.id, name: call.name, ok, output });
        emit({ type: "message", message: toolMsg });
      }
    }

    const overflow: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      content:
        "Stopped after the maximum number of tool turns. Ask me to continue if you want more work.",
      createdAt: nowIso(),
    };
    session.messages.push(overflow);
    session.status = "idle";
    session.updatedAt = nowIso();
    emit({ type: "message", message: overflow });
    emit({ type: "status", status: "idle" });
    emit({ type: "done", session });
    return session;
  } catch (err) {
    const message =
      err instanceof LlmError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    session.status = message === "Aborted" ? "idle" : "error";
    session.lastError = message === "Aborted" ? undefined : message;
    session.updatedAt = nowIso();
    if (message !== "Aborted") {
      emit({ type: "error", message });
    }
    emit({ type: "status", status: session.status });
    emit({ type: "done", session });
    return session;
  }
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
  // Do not start mid tool-result
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
  session.steps = [
    ...session.steps,
    { id: newId("step"), title, status, detail },
  ];
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_dir: "查看目录",
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "编辑文件",
    run_shell: "运行命令",
    list_skills: "列出技能",
    load_skill: "加载技能",
  };
  return labels[name] ?? name;
}

function summarizeArgs(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.name === "string") return obj.name;
  return undefined;
}
