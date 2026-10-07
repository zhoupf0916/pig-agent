/**
 * Task-level eval runner.
 *   pnpm eval:tasks                      # offline, in-process scenario mock model
 *   pnpm eval:tasks --real               # real model from LLM_BASE_URL/LLM_MODEL + DEEPSEEK_API_KEY|LLM_API_KEY
 *   --case <id>  --trials <n>  --out data/evals/tasks-latest.json  --min-pass 0.8 (exit 1 below)
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { taskCases } from "../apps/server/src/agent/evaluation/task-cases.ts";
import { markdownTable, runTaskCase, summarize, type TaskResult } from "../apps/server/src/agent/evaluation/task-eval.ts";
import { mockReply } from "../apps/server/src/dev/mock-scenarios.ts";

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? fallback : fallback);
const real = args.includes("--real");
const trials = Number(value("--trials", "1"));
const filter = value("--case", "");
const out = resolve(value("--out", `data/evals/tasks-${real ? "real" : "mock"}-latest.json`));
const minPass = Number(value("--min-pass", "0"));

async function mockServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const reply = mockReply(body.messages ?? [], "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = reply.toolCalls?.length ? { tool_calls: reply.toolCalls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : { content: reply.content ?? "" };
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close() };
}

const mock = real ? undefined : await mockServer();
const key = real ? (process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim() : "mock";
if (real && !key) throw new Error("--real needs LLM_API_KEY or DEEPSEEK_API_KEY in the environment");
const settings = {
  llmBaseUrl: real ? process.env.LLM_BASE_URL || "https://api.deepseek.com/v1" : mock!.url,
  llmApiKey: key, llmModel: real ? process.env.LLM_MODEL || "deepseek-chat" : "mock",
  runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub",
} as const;
const results: TaskResult[] = [];
for (const c of taskCases().filter((t) => !filter || t.id === filter)) for (let i = 0; i < trials; i++) {
  const r = await runTaskCase(c, settings as never);
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${c.id}#${i} calls=${r.modelCalls} tools=${r.toolCalls} tok=${r.promptTokens} cache=${r.cacheHitRate ?? "-"} ${(r.ms / 1000).toFixed(1)}s${r.error ? " err=" + r.error : ""}`);
}
mock?.close();
const summary = summarize(results);
const git = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ at: new Date().toISOString(), git, model: settings.llmModel, summary, results }, null, 2));
await writeFile(out.replace(/\.json$/, ".md"), `# Task eval ${git} (${settings.llmModel})\n\n${JSON.stringify(summary)}\n\n${markdownTable(results)}\n`);
console.log(JSON.stringify(summary));
if (summary.passRate < minPass) { console.error(`pass rate ${summary.passRate} < ${minPass}`); process.exit(1); }
