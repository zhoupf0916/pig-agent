import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const data = await mkdtemp(join(tmpdir(), "pig-desktop-smoke-"));
let calls = 0;
const model = createServer(async (request, response) => {
  if (
    request.url !== "/v1/chat/completions" ||
    request.headers.authorization !== "Bearer desktop-smoke-fake-key"
  ) {
    response.writeHead(401).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls++;
  if (body.stream) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { content: "OK" }, finish_reason: null }],
        }) +
        "\n\n",
    );
    response.end(
      "data: " +
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n",
    );
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }],
      }),
    );
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
let child;
try {
  const packaged =
    process.argv[2] === "--packaged"
      ? [
          join(
            root,
            `release/mac-${process.arch}/Pig Agent.app/Contents/MacOS/Pig Agent`,
          ),
          join(root, "release/mac/Pig Agent.app/Contents/MacOS/Pig Agent"),
        ].find(existsSync)
      : process.argv[2];
  if (process.argv[2] === "--packaged" && !packaged)
    throw new Error("Packaged app not found");
  const electron =
    packaged ||
    createRequire(join(root, "apps/desktop/package.json"))("electron");
  for (let attempt = 0; attempt < 2; attempt++) {
    child = spawn(electron, packaged ? [] : [join(root, "apps/desktop")], {
      env: {
        ...process.env,
        PIG_DESKTOP_SMOKE: "1",
        PIG_DESKTOP_SMOKE_RESTART: String(attempt),
        PIG_DESKTOP_USER_DATA: data,
        PIG_DESKTOP_SMOKE_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1`,
      },
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Desktop smoke timed out"));
      }, 60000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Electron exit ${code}`));
      });
    });
    const result = JSON.parse(await readFile(join(data, "smoke.json"), "utf8"));
    if (!result.ok || calls !== (attempt + 1) * 2)
      throw new Error(
        `Desktop smoke failed: ${JSON.stringify(result)}, mock calls=${calls}`,
      );
    await fetch(result.origin + "/api/health", {
      signal: AbortSignal.timeout(1000),
    }).then(
      () => {
        throw new Error("Backend survived desktop exit");
      },
      () => {},
    );
    console.log(
      `Desktop smoke ${attempt === 0 ? "launch" : "restart"} passed:`,
      {
        ...result,
        workspace: "[isolated test workspace]",
      },
    );
  }
} finally {
  model.closeAllConnections();
  model.close();
  await rm(data, { recursive: true, force: true });
}
