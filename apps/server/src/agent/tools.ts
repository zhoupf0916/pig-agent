import { nativeFileTool, FILE_TOOLS } from "./file-helper-client.ts";
import { nativeCommand, toolEnvironment } from "./native-sandbox.ts";
import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, posix } from "node:path";
import { HTTP_FETCH_ALLOWLIST } from "../config.ts";
import type { Artifact, ArtifactAction } from "../types.ts";
import { capText } from "../util.ts";
import { snippet } from "./diff.ts";
import { applyReplacements, applyUnifiedPatch, type Replacement } from "./patch.ts";
import { resolveInWorkspace, SandboxError, toRel } from "./sandbox.ts";
import { listSkills, loadSkill } from "./skills.ts";
import { safeHttpFetch, SsrfError } from "./ssrf.ts";

export const MAX_READ_CHARS = 120_000;
export const MAX_WRITE_CHARS = 400_000;
export const MAX_SHELL_CHARS = 32_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_MATCHES = 80;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_FILE_BYTES = 1_000_000;

const SHELL_DENY = [
  /(^|[\s;|&])sudo\b/i,
  /(^|[\s;|&])su\b/i,
  /(^|[\s;|&])ssh\b/i,
  /(^|[\s;|&])reboot\b/i,
  /(^|[\s;|&])shutdown\b/i,
  /(^|[\s;|&])mkfs\b/i,
  /rm\s+-rf\s+\/(?:\s|$)/i,
  /\bcurl\b.*\bfile:/i,
  /\bwget\b.*\bfile:/i,
  /169\.254\.169\.254/,
  /metadata\.google\.internal/i,
];

const PREFERRED_SHELL = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "grep",
  "rg",
  "find",
  "mkdir",
  "mv",
  "cp",
  "touch",
  "date",
  "echo",
  "printf",
  "python",
  "python3",
  "node",
  "npm",
  "pnpm",
  "git",
  "sed",
  "awk",
  "cut",
  "tr",
  "diff",
  "tree",
];

export type ArtifactPatch = Partial<Pick<Artifact, "fromPath" | "before" | "after">>;

export type ToolContext = {
  workspaceRoot: string;
  shellMode?: "host" | "docker" | "native";
  dockerImage?: string;
  dockerNetwork?: boolean;
  artifacts: Artifact[];
  recordArtifact: (path: string, action: ArtifactAction, extra?: ArtifactPatch) => void;
  signal?: AbortSignal;
};

export type ToolSandboxFact = {
  requested: string;
  /** Set only after this call's process or file API actually ran. */
  effective: "seatbelt" | "bubblewrap" | "host" | "workspace" | "尚未执行" | "未采集" | "远端 MCP 服务";
  backend: string;
};

export type ToolResult = {
  output: string;
  sandbox?: ToolSandboxFact;
};

export function sandboxFromError(error: unknown): ToolSandboxFact | undefined {
  if (!error || typeof error !== "object" || !("sandbox" in error)) return undefined;
  const sandbox = (error as { sandbox?: ToolSandboxFact }).sandbox;
  return sandbox?.effective ? sandbox : undefined;
}

function hostSandbox(ctx: ToolContext): ToolSandboxFact {
  return { requested: ctx.shellMode ?? "unset", effective: "host", backend: "host" };
}

function notExecuted(requested: string): ToolSandboxFact {
  return { requested, effective: "尚未执行", backend: "未采集" };
}

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "update_plan",
      description:
        "Replace the visible task plan with an ordered list of steps. Call this first, then again as steps complete.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "running", "done", "error"],
                },
                detail: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List files and directories under a workspace-relative path (default '.').",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Relative path inside the workspace" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "1-based start line (optional)" },
          limit: { type: "integer", description: "Max number of lines to return (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file inside the workspace. Creates parent directories.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Replace exactly one occurrence of old_string with new_string in a workspace file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "apply_patch",
      description:
        "Apply multiple unique replacements or a unified diff to one workspace text file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          patch: { type: "string", description: "Unified diff or *** Begin Patch block" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_files",
      description:
        "Search workspace text files for a regex or literal string. Returns path, line, and snippet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          path: { type: "string", description: "Directory or file to search (default '.')" },
          regex: { type: "boolean", description: "Treat query as a JS regex (default false)" },
          glob: { type: "string", description: "Optional filename glob, e.g. '*.md'" },
          max_matches: { type: "integer" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Delete a file (not a directory) inside the workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "move_file",
      description: "Move or rename a file or directory inside the workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description:
        "Run a shell command with cwd=workspace. Prefer simple commands (ls, rg, mkdir, python…). Output is capped; exit code is always returned. Do not escape the workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          timeout_ms: {
            type: "integer",
            description: "Timeout in milliseconds (default 30000, max 120000)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "http_fetch",
      description:
        "GET a public http(s) URL for research. Private/loopback IPs, credentials, and redirects are blocked. Size and time limited.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          timeout_ms: { type: "integer" },
          max_bytes: { type: "integer" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_skills",
      description: "List local skill playbooks the agent can load.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "load_skill",
      description: "Load the full markdown body of a local skill by name.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
];

type Json = Record<string, unknown>;

export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.signal?.aborted) throw new Error("Aborted");
  if (process.env.PIG_FILE_HELPER !== "1" && ctx.shellMode === "host" && (FILE_TOOLS.has(name) || name === "run_shell")) {
    throw Object.assign(new Error("沙箱未启用，已拒绝在主机上执行。"), { sandbox: notExecuted("host") });
  }
  if (process.env.PIG_FILE_HELPER !== "1" && FILE_TOOLS.has(name) && (process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX === "1" || ctx.shellMode === "native" || ctx.shellMode === "docker")) return nativeFileTool(name, rawArgs, ctx);
  const result = await executeUnsandboxed(name, rawArgs, ctx);
  if (!result.sandbox && FILE_TOOLS.has(name)) {
    result.sandbox = { requested: ctx.shellMode ?? "unset", effective: "workspace", backend: "workspace" };
  }
  if (!result.sandbox && name === "run_shell") result.sandbox = hostSandbox(ctx);
  return result;
}

async function executeUnsandboxed(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = asObject(rawArgs);
  switch (name) {
    case "update_plan":
      return { output: JSON.stringify({ ok: true, steps: args.steps ?? [] }) };
    case "list_dir":
      return listDir(ctx, String(args.path ?? "."));
    case "read_file":
      return readWorkspaceFile(
        ctx,
        String(args.path ?? ""),
        toInt(args.offset),
        toInt(args.limit),
      );
    case "write_file":
      return writeWorkspaceFile(ctx, String(args.path ?? ""), String(args.content ?? ""));
    case "edit_file":
      return editWorkspaceFile(
        ctx,
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
      );
    case "apply_patch":
      return applyPatchTool(ctx, String(args.path ?? ""), args);
    case "search_files":
      return searchFiles(ctx, args);
    case "delete_file":
      return deleteWorkspaceFile(ctx, String(args.path ?? ""));
    case "move_file":
      return moveWorkspaceFile(ctx, String(args.from ?? ""), String(args.to ?? ""));
    case "run_shell":
      return runShell(ctx, String(args.command ?? ""), toInt(args.timeout_ms));
    case "http_fetch":
      return httpFetchTool(ctx, args);
    case "list_skills":
      return { output: JSON.stringify(await listSkills(), null, 2) };
    case "load_skill":
      return { output: formatSkill(await loadSkill(String(args.name ?? ""))) };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function asObject(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Json;
  }
  return {};
}

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function toBool(value: unknown): boolean {
  return value === true || value === "true";
}

async function listDir(ctx: ToolContext, userPath: string): Promise<ToolResult> {
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath, { mustExist: true });
  const entries = await readdir(abs, { withFileTypes: true });
  const rows = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (shouldHide(entry.name)) continue;
    const full = join(abs, entry.name);
    let size: number | undefined;
    if (entry.isFile()) {
      try {
        size = (await stat(full)).size;
      } catch {
        size = undefined;
      }
    }
    rows.push({
      name: entry.name,
      path: toRel(ctx.workspaceRoot, full),
      type: entry.isDirectory() ? "dir" : "file",
      size,
    });
  }
  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { output: JSON.stringify({ path: toRel(ctx.workspaceRoot, abs), entries: rows }, null, 2) };
}

async function readWorkspaceFile(
  ctx: ToolContext,
  userPath: string,
  offset?: number,
  limit?: number,
): Promise<ToolResult> {
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath, { mustExist: true });
  if (isSecretName(abs.split(/[/\\]/).pop() ?? "")) throw new Error("Refusing to read a secret file");
  const st = await stat(abs);
  if (st.isDirectory()) {
    throw new Error("Path is a directory; use list_dir");
  }
  if (st.size > 2_000_000) {
    throw new Error("File is too large to read");
  }
  const raw = await readFile(abs, "utf8");
  if (raw.includes("\0")) {
    throw new Error("Refusing to read a binary file");
  }
  let text = raw;
  if (offset !== undefined || limit !== undefined) {
    const lines = raw.split(/\n/);
    const start = Math.max((offset ?? 1) - 1, 0);
    const end = limit !== undefined ? start + Math.max(limit, 0) : lines.length;
    text = lines.slice(start, end).join("\n");
  }
  return { output: capText(text, MAX_READ_CHARS) };
}

async function writeWorkspaceFile(
  ctx: ToolContext,
  userPath: string,
  content: string,
): Promise<ToolResult> {
  if (content.length > MAX_WRITE_CHARS) {
    throw new Error(`Content exceeds ${MAX_WRITE_CHARS} characters`);
  }
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath);
  const existed = await fileExists(abs);
  const before = existed ? await readTextIfPossible(abs) : undefined;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  const rel = toRel(ctx.workspaceRoot, abs);
  ctx.recordArtifact(rel, existed ? "modified" : "created", {
    before: snippet(before),
    after: snippet(content),
  });
  return { output: `${existed ? "Updated" : "Created"} ${rel} (${content.length} chars)` };
}

async function editWorkspaceFile(
  ctx: ToolContext,
  userPath: string,
  oldString: string,
  newString: string,
): Promise<ToolResult> {
  if (!oldString) throw new Error("old_string is required");
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath, { mustExist: true });
  const raw = await readFile(abs, "utf8");
  const matches = raw.split(oldString).length - 1;
  if (matches === 0) {
    throw new Error("old_string was not found in the file");
  }
  if (matches > 1) {
    throw new Error(`old_string matched ${matches} times; it must be unique`);
  }
  const next = raw.replace(oldString, newString);
  await writeFile(abs, next, "utf8");
  const rel = toRel(ctx.workspaceRoot, abs);
  ctx.recordArtifact(rel, "modified", { before: snippet(raw), after: snippet(next) });
  return { output: `Edited ${rel}` };
}

async function applyPatchTool(ctx: ToolContext, userPath: string, args: Json): Promise<ToolResult> {
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath, { mustExist: true });
  const raw = await readFile(abs, "utf8");
  const replacements = Array.isArray(args.replacements)
    ? (args.replacements as Replacement[])
    : [];
  const patch = typeof args.patch === "string" ? args.patch : "";
  let next: string;
  if (replacements.length > 0) {
    next = applyReplacements(raw, replacements);
  } else if (patch.trim()) {
    next = applyUnifiedPatch(raw, patch);
  } else {
    throw new Error("Provide replacements[] or a unified patch string");
  }
  await writeFile(abs, next, "utf8");
  const rel = toRel(ctx.workspaceRoot, abs);
  ctx.recordArtifact(rel, "modified", { before: snippet(raw), after: snippet(next) });
  return { output: `Patched ${rel}` };
}

async function searchFiles(ctx: ToolContext, args: Json): Promise<ToolResult> {
  const query = String(args.query ?? "");
  if (!query) throw new Error("query is required");
  const start = String(args.path ?? ".");
  const glob = typeof args.glob === "string" ? args.glob : undefined;
  const maxMatches = clamp(toInt(args.max_matches) ?? MAX_SEARCH_MATCHES, 1, 200);
  let pattern: RegExp;
  try {
    pattern = toBool(args.regex)
      ? new RegExp(query, "m")
      : new RegExp(escapeRegExp(query), "m");
  } catch {
    throw new Error("Invalid regular expression");
  }

  const abs = resolveInWorkspace(ctx.workspaceRoot, start, { mustExist: true });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let filesScanned = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (shouldHide(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (glob && !globMatch(entry.name, glob)) continue;
      filesScanned += 1;
      if (filesScanned > MAX_SEARCH_FILES) {
        truncated = true;
        return;
      }
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.size > MAX_SEARCH_FILE_BYTES) continue;
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const lines = text.split(/\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i]!)) {
          matches.push({
            path: toRel(ctx.workspaceRoot, full),
            line: i + 1,
            text: capText(lines[i]!.trim(), 240),
          });
          if (matches.length >= maxMatches) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  const st = await stat(abs);
  if (st.isFile()) {
    filesScanned = 1;
    const text = await readFile(abs, "utf8");
    if (!text.includes("\0")) {
      const lines = text.split(/\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i]!)) {
          matches.push({
            path: toRel(ctx.workspaceRoot, abs),
            line: i + 1,
            text: capText(lines[i]!.trim(), 240),
          });
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
    }
  } else {
    await visit(abs);
  }

  return {
    output: JSON.stringify(
      {
        query,
        path: toRel(ctx.workspaceRoot, abs),
        matches,
        files_scanned: filesScanned,
        truncated,
      },
      null,
      2,
    ),
  };
}

async function deleteWorkspaceFile(ctx: ToolContext, userPath: string): Promise<ToolResult> {
  const abs = resolveInWorkspace(ctx.workspaceRoot, userPath, { mustExist: true });
  const rel = toRel(ctx.workspaceRoot, abs);
  if (rel === ".") {
    throw new SandboxError("Refusing to delete the workspace root");
  }
  const st = await stat(abs);
  if (st.isDirectory()) {
    throw new Error("Path is a directory; delete files individually or use move_file");
  }
  const before = await readTextIfPossible(abs);
  await rm(abs);
  ctx.recordArtifact(rel, "deleted", { before: snippet(before) });
  return { output: `Deleted ${rel}` };
}

async function moveWorkspaceFile(
  ctx: ToolContext,
  fromPath: string,
  toPath: string,
): Promise<ToolResult> {
  const src = resolveInWorkspace(ctx.workspaceRoot, fromPath, { mustExist: true });
  const dest = resolveInWorkspace(ctx.workspaceRoot, toPath);
  const fromRel = toRel(ctx.workspaceRoot, src);
  const toRelPath = toRel(ctx.workspaceRoot, dest);
  if (fromRel === ".") {
    throw new SandboxError("Refusing to move the workspace root");
  }
  if (await fileExists(dest)) {
    throw new Error(`Destination already exists: ${toRelPath}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const before = await readTextIfPossible(src);
  await rename(src, dest);
  ctx.recordArtifact(toRelPath, "moved", {
    fromPath: fromRel,
    before: snippet(before),
    after: snippet(before),
  });
  return { output: `Moved ${fromRel} → ${toRelPath}` };
}

async function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs?: number,
): Promise<ToolResult> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command is required");
  const rejected = shellRejectedReason(trimmed);
  if (rejected) {
    throw new Error(rejected);
  }
  const timeout = clamp(timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS, 1_000, MAX_SHELL_TIMEOUT_MS);
  const preferred = isPreferredShell(trimmed);

  const env = toolEnvironment(ctx.workspaceRoot);

  const result = await new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    sandbox: ToolSandboxFact;
  }>((resolvePromise) => {
    const wantsNative = process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX === "1" || ctx.shellMode === "native" || ctx.shellMode === "docker";
    const container = wantsNative ? nativeCommand(ctx.workspaceRoot, trimmed, process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX !== "1" && ctx.dockerNetwork === true) : undefined;
    const child = container?.child ?? spawn(trimmed, {
      cwd: ctx.workspaceRoot,
      shell: true,
      detached: process.platform !== "win32",
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawned = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.once("spawn", () => { spawned = true; });
    const sandbox = (): ToolSandboxFact => {
      if (!spawned) return { requested: ctx.shellMode ?? (wantsNative ? "native" : "unset"), effective: "未采集", backend: "未采集" };
      if (container) return { requested: ctx.shellMode ?? "native", effective: container.backend, backend: container.backend };
      return hostSandbox(ctx);
    };
    const killProcess = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process has already exited */ }
    };
    const terminate = () => {
      killProcess("SIGTERM");
      killTimer ??= setTimeout(() => killProcess("SIGKILL"), 1500);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const onAbort = terminate;
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SHELL_CHARS * 2) terminate();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_SHELL_CHARS * 2) terminate();
    });
    const finish = (payload: {
      code: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      container?.cleanup();
      ctx.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ ...payload, sandbox: sandbox() });
    };
    child.on("close", (code, signal) => {
      finish({ code, signal: signal ?? null, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      finish({
        code: 1,
        signal: null,
        stdout: "",
        stderr: err.message,
        timedOut: false,
      });
    });
  });

  const payload = {
    command: trimmed,
    preferred_command: preferred,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout: capText(result.stdout, MAX_SHELL_CHARS),
    stderr: capText(result.stderr, MAX_SHELL_CHARS),
  };
  if (result.code !== 0 || result.timedOut || ctx.signal?.aborted) {
    throw Object.assign(new Error(JSON.stringify(payload, null, 2)), { sandbox: result.sandbox });
  }
  return { output: JSON.stringify(payload, null, 2), sandbox: result.sandbox };
}

async function httpFetchTool(ctx: ToolContext, args: Json): Promise<ToolResult> {
  try {
    const result = await safeHttpFetch(
      String(args.url ?? ""),
      {
        timeoutMs: toInt(args.timeout_ms),
        maxBytes: toInt(args.max_bytes),
        allowlist: HTTP_FETCH_ALLOWLIST,
        signal: ctx.signal,
      },
    );
    return {
      output: JSON.stringify(
        {
          url: result.url,
          status: result.status,
          content_type: result.contentType,
          truncated: result.truncated,
          body: capText(result.body, MAX_READ_CHARS),
        },
        null,
        2,
      ),
    };
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new Error(`HTTP fetch blocked: ${err.message}`);
    }
    throw err;
  }
}

export function shellRejectedReason(command: string): string | null {
  const lower = command.toLowerCase();
  if (/(^|[\s;|&])cd\s+\.\.(?:\s|$|[;/])/i.test(command)) {
    return "Command rejected: looks like a workspace escape";
  }
  if (/(^|[\s;|&])cd\s+\//.test(lower)) {
    return "Command rejected: looks like a workspace escape";
  }
  if (/(^|[\s;|&])(?:cat|less|rm|mv|cp)\s+\/(?!tmp\b)/i.test(command)) {
    return "Command rejected: looks like a workspace escape";
  }
  for (const rule of SHELL_DENY) {
    if (rule.test(command)) {
      return "Command rejected: pattern refused before sandbox execution. Isolation is the operating-system sandbox, not this denylist.";
    }
  }
  return null;
}

export function isPreferredShell(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return PREFERRED_SHELL.includes(base);
}

function isSecretName(name: string): boolean {
  return /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)$|id_(?:rsa|dsa|ed25519)(?:\.pub)?|credentials\.json|secrets\.json)$/i.test(name);
}

function shouldHide(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".DS_Store" ||
    name === "dist" ||
    name === "coverage" ||
    isSecretName(name)
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfPossible(path: string): Promise<string | undefined> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > 2_000_000) return undefined;
    const raw = await readFile(path, "utf8");
    if (raw.includes("\0")) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function formatSkill(skill: { name: string; description: string; body: string }): string {
  return `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globMatch(name: string, glob: string): boolean {
  const normalized = glob.trim();
  if (!normalized || normalized === "*") return true;
  const escaped = escapeRegExp(normalized).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

export function summarizeToolArgs(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.from === "string" && typeof obj.to === "string") {
    return `${obj.from} → ${obj.to}`;
  }
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.query === "string") return obj.query;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.name === "string") return obj.name;
  return undefined;
}

/** posix helper kept for tests that build virtual paths */
export const pathPosix = posix;
