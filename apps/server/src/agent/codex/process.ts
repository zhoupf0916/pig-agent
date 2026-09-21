import { spawn } from "node:child_process";
import { resolveCodexApiKey, resolveCodexApiKeyEnvName } from "../../config.ts";

export const SIGKILL_GRACE_MS = 1500;

export type KillFn = (pid: number, signal?: NodeJS.Signals) => void;
export type SleepFn = (ms: number) => Promise<void>;

export type CodexProcessHooks = {
  kill?: KillFn;
  sleep?: SleepFn;
  spawn?: typeof spawn;
};

export type CodexExecRequest = {
  binary: string;
  prompt: string;
  workspaceReal: string;
  home: string;
  model: string;
  networkAccess: boolean;
  signal: AbortSignal;
  onLine: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  hooks?: CodexProcessHooks;
};

export function buildCodexExecArgs(options: {
  workspaceReal: string;
  prompt: string;
  model: string;
  networkAccess?: boolean;
}): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-C",
    options.workspaceReal,
    "--model",
    options.model,
    "--sandbox",
    "workspace-write",
    "--config",
    `sandbox_workspace_write.network_access=${options.networkAccess === true}`,
    options.prompt,
  ];
}

export type KillableChild = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  killed?: boolean;
  exitCode?: number | null;
};

export async function killProcessGroup(
  child: KillableChild,
  options: { kill?: KillFn; sleep?: SleepFn; graceMs?: number } = {},
): Promise<void> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = options.graceMs ?? SIGKILL_GRACE_MS;
  const pid = child.pid;

  const send = (target: number, signal: NodeJS.Signals) => {
    try {
      kill(target, signal);
    } catch {
      if (pid && target === -pid) {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    }
  };

  if (pid) send(-pid, "SIGTERM");
  else {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  await sleep(graceMs);

  if (typeof child.exitCode === "number") return;

  if (pid) send(-pid, "SIGKILL");
  else {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function runCodexExec(req: CodexExecRequest): Promise<{
  code: number | null;
  stderr: string;
  aborted: boolean;
}> {
  if (req.signal.aborted) return { code: null, stderr: "", aborted: true };
  const args = buildCodexExecArgs({
    workspaceReal: req.workspaceReal,
    prompt: req.prompt,
    model: req.model,
    networkAccess: req.networkAccess,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...req.env,
    CODEX_HOME: req.home,
  };
  const key = resolveCodexApiKey(req.env ?? process.env);
  const keyName = resolveCodexApiKeyEnvName(req.env ?? process.env);
  delete env.DEEPSEEK_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.LLM_API_KEY;
  delete env.OPENAI_API_KEY;
  if (key) env[keyName] = key;
  // Do not map pig Chat Completions URL into the child.
  delete env.LLM_BASE_URL;

  const spawnFn = req.hooks?.spawn ?? spawn;
  const child = spawnFn(req.binary, args, {
    cwd: req.workspaceReal,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stderr = "";
  let buffer = "";
  let aborted = false;

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + chunk.toString()).slice(-24_000);
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) req.onLine(line);
    }
  });

  const abort = () => {
    aborted = true;
    void killProcessGroup(child, {
      kill: req.hooks?.kill,
      sleep: req.hooks?.sleep,
    });
  };
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });

  let code: number | null;
  try { code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  }); } finally { req.signal.removeEventListener("abort", abort); }

  if (buffer.trim()) req.onLine(buffer);
  return { code, stderr, aborted };
}
