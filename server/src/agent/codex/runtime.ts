import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent, Artifact, ChatMessage, Session, Settings } from "../../types.ts";
import { capText, newId, nowIso } from "../../util.ts";
import { deliverableSummary } from "../runtime.ts";
import { isInsideWorkspace, toRel } from "../sandbox.ts";
import { mapCodexEvent, parseCodexJsonlLine, type CodexMapped } from "./events.ts";
import { assertCwdMatchesWorkspace, resolveTrustedWorkspace, syncCodexHome } from "./home.ts";
import { assembleCodexPrompt, CODEX_HISTORY_MESSAGES } from "./prompt.ts";
import { runCodexExec, type CodexProcessHooks } from "./process.ts";
import { assertCodexReady, CodexValidationError } from "./validate.ts";

const TOOL_OUTPUT_CHARS = 12_000;

export async function runCodexAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  hooks?: CodexProcessHooks;
  projectInstruction?: string;
  expertInstruction?: string;
}): Promise<Session> {
  const { settings, signal, emit, hooks, projectInstruction, expertInstruction } = options;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    updatedAt: nowIso(),
  };
  emit({ type: "status", status: "running" });

  try {
    const { binary, home } = assertCodexReady(settings);
    const synced = await syncCodexHome(settings, { home });
    const workspaceReal = synced.workspaceRealPath ?? resolveTrustedWorkspace(settings.workspaceRoot);
    assertCwdMatchesWorkspace(workspaceReal, workspaceReal);

    const prompt = assembleCodexPrompt(
      session.messages,
      CODEX_HISTORY_MESSAGES,
      projectInstruction,
      expertInstruction,
    );
    if (!prompt) {
      throw new Error("No user/assistant text to send to Codex");
    }

    const artifacts = new Map<string, Artifact>(session.artifacts.map((a) => [a.path, a]));
    const snapshot = snapshotTextFiles(workspaceReal);
    const pending = new Map<string, { name: string; args: unknown; startedAt: number; assistantId: string }>();
    let fatal: string | undefined;

    const apply = (mapped: CodexMapped) => {
      if (mapped.kind === "ignore") return;
      if (mapped.kind === "status") {
        emit({ type: "status", status: mapped.status });
        return;
      }
      if (mapped.kind === "assistant") {
        const message: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          content: mapped.content,
          createdAt: nowIso(),
        };
        session.messages.push(message);
        emit({ type: "message", message });
        return;
      }
      if (mapped.kind === "tool_start") {
        const startedAt = nowIso();
        const assistant: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: mapped.id,
              name: mapped.name,
              arguments: stringifyArgs(mapped.arguments),
            },
          ],
          createdAt: startedAt,
        };
        session.messages.push(assistant);
        pending.set(mapped.id, {
          name: mapped.name,
          args: mapped.arguments,
          startedAt: Date.now(),
          assistantId: assistant.id,
        });
        emit({ type: "message", message: assistant });
        emit({
          type: "tool_start",
          id: mapped.id,
          name: mapped.name,
          arguments: mapped.arguments,
          startedAt,
        });
        return;
      }
      if (mapped.kind === "tool_end") {
        const start = pending.get(mapped.id);
        if (!start) {
          const assistant: ChatMessage = {
            id: newId("msg"),
            role: "assistant",
            content: "",
            toolCalls: [
              { id: mapped.id, name: mapped.name, arguments: "{}" },
            ],
            createdAt: nowIso(),
          };
          session.messages.push(assistant);
          emit({ type: "message", message: assistant });
          emit({
            type: "tool_start",
            id: mapped.id,
            name: mapped.name,
            arguments: {},
            startedAt: nowIso(),
          });
        }
        const durationMs = start ? Date.now() - start.startedAt : 0;
        const output = capText(mapped.output, TOOL_OUTPUT_CHARS);
        const toolMsg: ChatMessage = {
          id: newId("msg"),
          role: "tool",
          content: output,
          toolCallId: mapped.id,
          toolOk: mapped.ok,
          toolDurationMs: durationMs,
          createdAt: nowIso(),
        };
        session.messages.push(toolMsg);
        pending.delete(mapped.id);
        emit({
          type: "tool_end",
          id: mapped.id,
          name: mapped.name,
          ok: mapped.ok,
          output,
          durationMs,
        });
        emit({ type: "message", message: toolMsg });
        return;
      }
      if (mapped.kind === "artifact") {
        recordArtifact(workspaceReal, artifacts, session, emit, snapshot, mapped.path, mapped.action);
        return;
      }
      if (mapped.kind === "error") {
        fatal = mapped.message;
        emit({ type: "error", message: mapped.message });
        return;
      }
    };

    if (signal.aborted) throw new Error("Aborted");

    const result = await runCodexExec({
      binary,
      prompt,
      workspaceReal,
      home,
      model: settings.codexModel,
      networkAccess: settings.codexNetworkAccess,
      signal,
      hooks,
      onLine: (line) => {
        const parsed = parseCodexJsonlLine(line);
        if (!parsed) return;
        for (const mapped of mapCodexEvent(parsed)) apply(mapped);
      },
    });

    if (result.aborted || signal.aborted) {
      throw new Error("Aborted");
    }

    if (fatal) {
      session.status = "error";
      session.lastError = fatal;
      session.updatedAt = nowIso();
      emit({ type: "status", status: "error" });
      emit({ type: "done", session });
      return session;
    }

    if (result.code !== 0 && result.code !== null) {
      const detail = result.stderr.trim() || `codex exec exited ${result.code}`;
      session.status = "error";
      session.lastError = detail;
      session.updatedAt = nowIso();
      emit({ type: "error", message: detail });
      emit({ type: "status", status: "error" });
      emit({ type: "done", session });
      return session;
    }

    if (!session.messages.some((m) => m.role === "assistant" && m.content.trim())) {
      const fallback: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        content: deliverableSummary(session, "Codex 本轮已结束。"),
        createdAt: nowIso(),
      };
      session.messages.push(fallback);
      emit({ type: "message", message: fallback });
    }

    session.status = "idle";
    session.updatedAt = nowIso();
    emit({ type: "status", status: "idle" });
    emit({ type: "done", session });
    return session;
  } catch (err) {
    const message =
      err instanceof CodexValidationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const aborted = message === "Aborted" || signal.aborted;
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
    } else {
      session.status = "error";
      session.lastError = message;
      emit({ type: "error", message });
    }
    session.updatedAt = nowIso();
    emit({ type: "status", status: session.status });
    emit({ type: "done", session });
    return session;
  }
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function recordArtifact(
  workspaceReal: string,
  artifacts: Map<string, Artifact>,
  session: Session,
  emit: (event: AgentEvent) => void,
  snapshot: Map<string, string>,
  rawPath: string,
  action: Artifact["action"],
): void {
  const rel = toWorkspaceRel(workspaceReal, rawPath);
  if (!rel) return;
  const abs = resolve(workspaceReal, rel);
  let after: string | undefined;
  let before = snapshot.get(rel);
  if (action !== "deleted" && existsSync(abs)) {
    try {
      after = readFileSync(abs, "utf8");
    } catch {
      after = undefined;
    }
  }
  if (action === "created") before = undefined;
  const artifact: Artifact = {
    path: rel,
    action,
    updatedAt: nowIso(),
    before,
    after,
  };
  artifacts.set(rel, artifact);
  session.artifacts = [...artifacts.values()].sort((a, b) => a.path.localeCompare(b.path));
  emit({ type: "artifact", artifact });
}

function toWorkspaceRel(workspaceReal: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceReal, trimmed);
  if (!isInsideWorkspace(workspaceReal, abs)) return null;
  const rel = relative(workspaceReal, abs);
  if (rel.startsWith(`..${sep}`) || rel === "..") return null;
  return rel === "" ? "." : rel.split(sep).join("/");
}

function snapshotTextFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth <= 0 || out.size >= 400) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
      const full = resolve(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth - 1);
        } else if (st.isFile() && st.size < 200_000) {
          const rel = toRel(root, full);
          try {
            const buf = readFileSync(full);
            if (!buf.includes(0)) out.set(rel, buf.toString("utf8"));
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
    }
  };
  walk(root, 6);
  return out;
}
