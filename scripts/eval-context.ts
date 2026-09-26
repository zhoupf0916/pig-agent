import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runOffline, strategies, modelMessages, gradeAnswer, type Strategy } from "../apps/server/src/agent/evaluation/context-eval.ts";
import { contextCases } from "../apps/server/src/agent/evaluation/context-cases.ts";
const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fallback : fallback;
const trials = Number(value("--trials", "3"));
if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("--trials must be 1..20");
const output = resolve(value("--out", "data/evals/context-latest.json"));
const implementationSha256 = createHash("sha256").update(await readFile(new URL("../packages/contracts/src/context.ts", import.meta.url))).digest("hex");
const metadata = { implementationSha256, at: new Date().toISOString(), git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), node: process.version, platform: `${process.platform}/${process.arch}`,
  fixtureSha256: createHash("sha256").update(JSON.stringify(contextCases())).digest("hex") };
const offline = runOffline(trials);
const modelRows: unknown[] = [];
const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
if (args.includes("--model")) {
  const key = process.env.PIG_EVAL_API_KEY;
  const model = process.env.PIG_EVAL_MODEL;
  const base = process.env.PIG_EVAL_BASE_URL;
  if (!key || !model || !base) throw new Error("Set PIG_EVAL_API_KEY, PIG_EVAL_MODEL and PIG_EVAL_BASE_URL explicitly; repository .env is never read.");
  const url = new URL(base.replace(/\/$/, "") + "/chat/completions");
  if (url.username || url.password || url.search || url.hash) throw new Error("Endpoint cannot contain credentials/query/fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("Use HTTPS or a loopback mock endpoint");
  const limit = Number(value("--max-calls", "12"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--max-calls must be 1..200");
  const filter = value("--case", "");
  const tasks = contextCases().filter(t => !filter || t.id === filter);
  if (!tasks.length) throw new Error("Unknown --case");
  const requiredCalls = tasks.length * trials * 2;
  if (requiredCalls > limit) throw new Error(`Planned ${requiredCalls} calls exceed --max-calls ${limit}; choose --case or increase limit explicitly.`);
  for (const task of tasks) for (let trial = 0; trial < trials; trial++) {
    // Alternate ordering to reduce systematic provider warm-cache/order bias.
    const order: Strategy[] = trial % 2 ? ["structured-v2", "baseline-v1"] : ["baseline-v1", "structured-v2"];
    for (const strategy of order) {
      const result = strategies[strategy]({ messages: task.messages, systemChars: 0, toolSchemaChars: 0, budgetChars: task.budgetChars });
      const started = performance.now();
      try {
        const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(60_000), headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, temperature: 0, max_tokens: 256, messages: modelMessages(result.messages) }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const answer = body.choices?.[0]?.message?.content ?? "";
        modelRows.push({ id: task.id, strategy, trial, passed: gradeAnswer(answer, task.answer), durationMs: performance.now() - started,
          promptTokens: tokenCount(body.usage?.prompt_tokens), completionTokens: tokenCount(body.usage?.completion_tokens) });
      } catch (error) {
        const safeError = error instanceof Error && /^http_\d+$/.test(error.message) ? error.message : "transport_or_response_error";
        modelRows.push({ id: task.id, strategy, trial, passed: false, error: safeError, durationMs: performance.now() - started });
      }
      // Checkpoint after every call. No keys, headers, raw provider errors or prompt bodies in reports.
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ metadata, model, kind: "model-context-outcome", complete: false, plannedCalls: requiredCalls, modelRows }, null, 2));
    }
  }
}
const report = { metadata, ...offline, kind: args.includes("--model") ? "model-context-outcome" : offline.kind, modelCalls: modelRows.length, model: args.includes("--model") ? process.env.PIG_EVAL_MODEL : null, complete: true, modelRows };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
for (const strategy of Object.keys(strategies) as Strategy[]) {
  const rows = offline.rows.filter(r => r.strategy === strategy);
  const times = rows.flatMap(r => r.assemblyMs).sort((a, b) => a - b);
  console.log(`${strategy}: input gates ${rows.filter(r => !r.failures.length).length}/${rows.length}; assembly p95=${times[Math.ceil(times.length * .95) - 1]?.toFixed(2)}ms`);
}
console.log(`Report: ${output}; actual model calls=${modelRows.length}. Offline gates are NOT model task success.`);
if (offline.rows.some(r => r.strategy === "structured-v2" && r.failures.length)) process.exitCode = 1;

if (modelRows.some(row => { const r = row as { strategy: string; passed: boolean }; return r.strategy === "structured-v2" && !r.passed; })) process.exitCode = 1;
