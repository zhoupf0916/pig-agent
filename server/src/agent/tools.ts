import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact } from "../types.ts";
import { capText } from "../util.ts";
import { resolveInWorkspace, toRel } from "./sandbox.ts";
import { listSkills, loadSkill } from "./skills.ts";

export const MAX_READ_CHARS = 120_000;
export const MAX_WRITE_CHARS = 400_000;
export const MAX_SHELL_CHARS = 32_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;
const MAX_LIST_ENTRIES = 400;

export type ToolContext = {
  workspaceRoot: string;
  artifacts: Artifact[];
  recordArtifact: (path: string, action: "created" | "modified") => void;
};

export type ToolResult = {
  output: string;
};

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
      description:
        "List files and directories under a workspace-relative path (default '.').",
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
          offset: {
            type: "integer",
            description: "1-based start line (optional)",
          },
          limit: {
            type: "integer",
            description: "Max number of lines to return (optional)",
          },
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
      name: "run_shell",
      description:
        "Run a shell command with cwd set to the workspace root. Output is capped. Do not use this to escape the workspace.",
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
    case "run_shell":
      return runShell(ctx, String(args.command ?? ""), toInt(args.timeout_ms));
    case "list_skills":
      return { output: JSON.stringify(await listSkills(), null, 2) };
    case "load_skill":
      return {
        output: formatSkill(await loadSkill(String(args.name ?? ""))),
      };
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
  return {
    output: capText(text, MAX_READ_CHARS),
  };
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
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  const rel = toRel(ctx.workspaceRoot, abs);
  ctx.recordArtifact(rel, existed ? "modified" : "created");
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
  ctx.recordArtifact(rel, "modified");
  return { output: `Edited ${rel}` };
}

async function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs?: number,
): Promise<ToolResult> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command is required");
  if (looksLikeEscape(trimmed)) {
    throw new Error("Command rejected: looks like a workspace escape");
  }
  const timeout = clamp(
    timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    1_000,
    MAX_SHELL_TIMEOUT_MS,
  );

  const env = { ...process.env };
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  env.HOME = ctx.workspaceRoot;
  env.PWD = ctx.workspaceRoot;
  env.PIG_AGENT_WORKSPACE = ctx.workspaceRoot;

  const result = await new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolvePromise) => {
    const child = spawn(trimmed, {
      cwd: ctx.workspaceRoot,
      shell: true,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500);
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_SHELL_CHARS * 2) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal: signal ?? null, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: 1,
        signal: null,
        stdout: "",
        stderr: err.message,
        timedOut: false,
      });
    });
  });

  const payload = {
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout: capText(result.stdout, MAX_SHELL_CHARS),
    stderr: capText(result.stderr, MAX_SHELL_CHARS),
  };
  return { output: JSON.stringify(payload, null, 2) };
}

function looksLikeEscape(command: string): boolean {
  const lower = command.toLowerCase();
  if (/(^|[\s;|&])cd\s+\.\.(?:\s|$|[;/])/i.test(command)) return true;
  if (/(^|[\s;|&])cd\s+\//.test(lower)) return true;
  // Absolute writes / copies outside typical workspace-relative usage
  if (/(^|[\s;|&])(?:cat|less|rm|mv|cp)\s+\/(?!tmp\b)/i.test(command)) return true;
  return false;
}

function shouldHide(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".DS_Store";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatSkill(skill: { name: string; description: string; body: string }): string {
  return `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
