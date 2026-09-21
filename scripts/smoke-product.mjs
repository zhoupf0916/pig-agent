import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
const base = "http://127.0.0.1:8798";
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", () =>
    reject(
      Error(
        "Port 8798 is occupied. Stop the isolated acceptance server before product:smoke.",
      ),
    ),
  );
  probe.listen(8798, "127.0.0.1", () => probe.close(resolve));
});
const secrets = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
const env = {
  ...process.env,
  PIG_DESKTOP: "1",
  PORT: "8798",
  DATA_DIR: resolve("data/product-acceptance"),
  WORKSPACE_ROOT: resolve("data/product-workspace"),
};
for (const key of Object.keys(env))
  if (/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_)/.test(key)) delete env[key];
await mkdir(env.WORKSPACE_ROOT, { recursive: true });
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: resolve("apps/server"),
  env,
  stdio: "inherit",
});
async function command(file, extra = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...env, ...extra },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(file + " exited " + code)),
    );
  });
}
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + "/api/settings")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw Error("Acceptance server not ready");
  const saved = await fetch(base + "/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runtime: "pig",
      llmApiKey: "",
      cloudMode: "remote",
      cloudBaseUrl: "http://127.0.0.1:8892",
      cloudToken: secrets.MEMBER_TOKEN,
      workspaceRoot: env.WORKSPACE_ROOT,
    }),
  });
  if (!saved.ok) throw Error("Failed to configure isolated workbench");
  await command("scripts/smoke-product-flow.mjs");
  await command("apps/web/scripts/smoke-product-ui.mjs");
  await command("apps/web/scripts/smoke-session-creation.mjs");
  await command("apps/web/scripts/smoke-remote-following.mjs");
  await command("apps/admin/smoke-ui.mjs", { ADMIN_UI_MUTATE: "1" });
  console.log(
    "PASS: product browser acceptance; evidence in data/product-evidence.",
  );
} finally {
  server.kill("SIGTERM");
}
