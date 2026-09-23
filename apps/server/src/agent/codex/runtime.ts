import { codexEnvironment } from "./environment.ts";
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent, Artifact, ChatMessage, Session, Settings } from "../../types.ts";
import { capText, newId, nowIso } from "../../util.ts";
import { CreateRunProgress } from "../cloud/create-run-progress.ts";
import { deliverableSummary } from "../runtime.ts";
import { isInsideWorkspace, toRel } from "../sandbox.ts";
import { CodexSessionError, decideCodexRetry, formatCodexTurnError } from "./errors.ts";
import { mapCodexEvent, parseCodexJsonlLine, type CodexMapped } from "./events.ts";
import { assertCwdMatchesWorkspace, resolveTrustedWorkspace, syncCodexHome } from "./home.ts";
import { assembleCodexPrompt, CODEX_HISTORY_MESSAGES } from "./prompt.ts";
import { runCodexExec, type CodexProcessHooks } from "./process.ts";
import { assertCodexReady } from "./validate.ts";

const TOOL_OUTPUT_CHARS = 12_000;

export async function runCodexAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  hooks?: CodexProcessHooks;
  environment?: NodeJS.ProcessEnv;
  projectInstruction?: string;
  expertInstruction?: string;
  preferredSkillIds?: string[];
  mcpTools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
  mcpInvoke?: (call: { name: string; args: Record<string, unknown>; signal: AbortSignal; callId: string }) => Promise<string>;
}): Promise<Session> {
  const { settings, signal, emit, hooks, projectInstruction, expertInstruction } = options;
  const session: Session = {
    ...options.session,
    status: "running",
    lastError: undefined,
    localRetry: undefined,
    remoteRetry: undefined,
    updatedAt: nowIso(),
  };
  emit({ type: "status", status: "running" });

  const progress = new CreateRunProgress(session, emit);
  let handedOff = false;
  const releaseBootstrap = () => {
    if (handedOff) return;
    handedOff = true;
    if (signal.aborted) progress.abort();
    else progress.handoffToStream();
  };

  try {
    progress.begin("env");
    const env = codexEnvironment(settings, options.environment ?? process.env);
    const { binary, home } = assertCodexReady(settings, env);
    const synced = await syncCodexHome(settings, { home, env });
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

    const turnMessageStart = session.messages.length;
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
        releaseBootstrap();
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
        releaseBootstrap();
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
          releaseBootstrap();
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
        return;
      }
    };

    if (signal.aborted) throw new Error("Aborted");

    progress.begin("spawn");
    const result = await runCodexExec({
      binary,
      env,
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
      return failCodexTurn(session, new CodexSessionError(fatal), emit, releaseBootstrap);
    }

    if (result.code !== 0 && result.code !== null) {
      const detail = result.stderr.trim() || `codex exec exited ${result.code}`;
      return failCodexTurn(session, new CodexSessionError(detail), emit, releaseBootstrap);
    }

    if (!session.messages.slice(turnMessageStart).some((m) => m.role === "assistant" && m.content.trim())) {
      releaseBootstrap();
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
    releaseBootstrap();
    emit({ type: "status", status: "idle" });
    emit({ type: "done", session });
    return session;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const aborted = raw === "Aborted" || signal.aborted;
    if (aborted) {
      releaseBootstrap();
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
      session.updatedAt = nowIso();
      emit({ type: "status", status: "idle" });
      emit({ type: "done", session });
      return session;
    }
    return failCodexTurn(session, err, emit, releaseBootstrap);
  }
}

function failCodexTurn(
  session: Session,
  err: unknown,
  emit: (event: AgentEvent) => void,
  releaseBootstrap?: () => void,
): Session {
  releaseBootstrap?.();
  session.status = "idle";
  session.lastError = formatCodexTurnError(err);
  session.localRetry = decideCodexRetry(session);
  session.remoteRetry = undefined;
  session.updatedAt = nowIso();
  emit({ type: "error", message: session.lastError });
  emit({ type: "status", status: "idle" });
  emit({ type: "done", session });
  return session;
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
      if (!isInsideWorkspace(workspaceReal, realpathSync(abs))) return;
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
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
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
