import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("runs paired model trials against a loopback provider without exposing credentials or answer keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "pig-context-eval-"));
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      expect(body).not.toHaveProperty("answer");
      expect(body.messages.at(-1).content).not.toContain("391");
      const knows = raw.includes("total=391");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ total: knows ? "391" : "unknown" }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("missing address");
  try {
    const out = join(root, "result.json");
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/eval-context.ts", "--model", "--case", "middle-evidence-50", "--trials", "2", "--max-calls", "4", "--out", out], {
      cwd: process.cwd(), env: { ...process.env, PIG_EVAL_API_KEY: "synthetic-eval-credential", PIG_EVAL_MODEL: "fixture-model", PIG_EVAL_BASE_URL: `http://127.0.0.1:${addr.port}/v1` }, stdio: "pipe",
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exit = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); });
    expect(exit, output).toBe(0);
    const raw = await readFile(out, "utf8");
    const report = JSON.parse(raw);
    expect(calls).toBe(4);
    expect(report.modelCalls).toBe(4);
    expect(report.kind).toBe("model-context-outcome");
    expect(report.modelRows.filter((r: { strategy: string }) => r.strategy === "structured-v2").every((r: { passed: boolean }) => r.passed)).toBe(true);
    expect(raw + output).not.toContain("synthetic-eval-credential");
    expect(report.modelRows[0].promptTokens).toBe(100);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
