import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./mock-task-bench-worker.mjs", import.meta.url));
const tasks = ["short", "stream", "read", "multi-write", "approvals", "long-context", "cancel", "reconnect"];
const samples = 5;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function series(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => typeof value === "number");
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

function summarize(rows) {
  return {
    succeeded: rows.length,
    startupMs: series(rows, "startupMs"),
    ttftMs: series(rows, "ttftMs"),
    firstToolMs: series(rows, "firstToolMs"),
    totalMs: series(rows, "totalMs"),
    modelWaitMs: series(rows, "modelWaitMs"),
    overheadMs: series(rows, "overheadMs"),
    reconnectMs: series(rows, "reconnectMs"),
  };
}

function childEnv(dataDir, workspace) {
  const env = { ...process.env, PIG_DESKTOP: "1", DATA_DIR: dataDir, WORKSPACE_ROOT: workspace };
  for (const key of Object.keys(env)) {
    if (/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|PIG_CLOUD_|CLOUD_)/.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  return env;
}

function runChild(args, dataDir, workspace, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
      cwd: root,
      env: childEnv(dataDir, workspace),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let readyMs = null;
    const events = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} timed out\n${stderr.slice(-500)}`));
    }, timeoutMs);
    const take = (line) => {
      if (!line.startsWith("BENCH ")) return;
      const event = JSON.parse(line.slice(6));
      if (event.event === "ready") readyMs = Date.now() - started;
      else events.push(event);
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) take(line.trim());
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) take(buffer.trim());
      if (code !== 0) {
        reject(new Error(`${args.join(" ")} exit ${code}: ${stderr.slice(-800) || JSON.stringify(events)}`));
        return;
      }
      if (readyMs === null) {
        reject(new Error(`${args.join(" ")} did not report ready`));
        return;
      }
      resolve({ readyMs, events });
    });
  });
}

const report = {
  at: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  samplesRequested: samples,
  isolation: "PIG_DESKTOP=1 disables dotenv; DATA_DIR and WORKSPACE_ROOT are fresh temp directories; model keys are removed from the child environment",
  method: {
    coldStartup: "Milliseconds from parent spawn until the child prints ready, after imports and before the task.",
    hot: "One process imports once, runs one discarded warmup, then five samples. startupMs is in-process session preparation, not a new process.",
    ttft: "Client time until the first text token. Null when the task has no text token. firstToolMs is the first tool_start and is separate.",
    overhead: "Per-sample totalMs minus that sample's measured model wait. Percentiles are taken from those per-sample values. Model calls in these tasks do not overlap.",
    reconnect: "reconnectMs is only the cursor resume read. It is not added to totalMs.",
  },
  limits: [
    "本机单个 Node 进程和模拟模型，不连接 8890 或 8892，也不使用真实模型。",
    "冷启动包含进程启动和模块加载，不包含任务本身。热样本复用同一次进程预热。",
    "模型等待按每个样本实际累计的模拟延迟测量，不是固定 30ms，也不能把两个分位数相减当开销。",
    "这些数字不是生产容量，也不表示并行优化的收益。",
  ],
  tasks: {},
  samples: [],
  failures: [],
};

for (const task of tasks) {
  const cold = [];
  for (let index = 0; index < samples; index += 1) {
    const dir = await mkdtemp(join(tmpdir(), "pig-bench-"));
    try {
      const result = await runChild(["--mode", "cold", "--task", task, "--index", String(index)], join(dir, "data"), join(dir, "workspace"), 30000);
      const sample = result.events.find((event) => event.event === "sample");
      if (!sample?.ok) throw new Error(sample?.error || "missing sample");
      cold.push({ ...sample, startupMs: result.readyMs });
    } catch (error) {
      report.failures.push({ task, phase: "cold", index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const hotDir = await mkdtemp(join(tmpdir(), "pig-bench-hot-"));
  let hot = [];
  try {
    const result = await runChild(["--mode", "hot", "--task", task, "--samples", String(samples)], join(hotDir, "data"), join(hotDir, "workspace"), 60000);
    const warmup = result.events.find((event) => event.event === "warmup");
    if (!warmup?.ok) throw new Error(warmup?.error || "warmup failed");
    hot = result.events.filter((event) => event.event === "sample" && event.ok);
    for (const event of result.events) {
      if (event.event === "sample" && !event.ok) report.failures.push({ task, phase: "hot", index: event.index, error: event.error });
    }
  } catch (error) {
    report.failures.push({ task, phase: "hot", error: error instanceof Error ? error.message : String(error) });
  }
  report.tasks[task] = {
    cold: summarize(cold),
    hot: summarize(hot),
    startupDefinition: { cold: "spawn-to-ready", hot: "warm-process session prepare" },
  };
  report.samples.push(...cold.map((row) => ({ ...row, phase: "cold" })), ...hot.map((row) => ({ ...row, phase: "hot" })));
  console.log(task, "cold", report.tasks[task].cold.succeeded, report.tasks[task].cold.totalMs, "hot", report.tasks[task].hot.succeeded, report.tasks[task].hot.totalMs);
}

const outDir = join(root, "docs/evidence/runtime-debugger-bench-2026-09-23");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log("wrote", join(outDir, "report.json"));
if (report.failures.length || tasks.some((task) => report.tasks[task].cold.succeeded < samples || report.tasks[task].hot.succeeded < samples)) {
  console.error(JSON.stringify(report.failures, null, 2));
  process.exit(1);
}
