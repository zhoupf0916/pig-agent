import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const data = await mkdtemp(join(tmpdir(), "pig-debug-shot-"));
const outDir = process.env.PIG_DEBUG_SHOT_OUT || join(root, "docs/evidence/runtime-debugger-2026-09-23");
let step = 0;
const model = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer desktop-smoke-fake-key") {
    response.writeHead(401).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  step += 1;
  if (!body.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = step === 1
    ? { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }] }
    : { content: "OK" };
  response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const electron = createRequire(join(root, "apps/desktop/package.json"))("electron");
const child = spawn(electron, [join(root, "apps/desktop")], {
  env: {
    ...process.env,
    PIG_DESKTOP_SMOKE: "1",
    PIG_DESKTOP_DEBUG_SHOT: "1",
    PIG_DESKTOP_INSTANCE: `Pig Agent Detail ${process.pid}`,
    PIG_DESKTOP_USER_DATA: data,
    PIG_DESKTOP_DEBUG_SHOT_DIR: outDir,
    PIG_DESKTOP_SMOKE_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1`,
  },
  stdio: "inherit",
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Electron debug shot timed out"));
    }, 90000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`));
    });
  });
  const result = JSON.parse(await readFile(join(data, "smoke.json"), "utf8"));
  if (!result.ok) throw new Error(result.error || "debug shot failed");
  console.log("Developer tab captured", { spans: result.spans, outDir });
} finally {
  model.close();
}
