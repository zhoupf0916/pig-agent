import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const data = await mkdtemp(join(tmpdir(), "pig-approval-shot-"));
const outDir = process.env.PIG_DEBUG_SHOT_OUT || join(root, "docs/evidence/runtime-debugger-finish-2026-09-23");
const electron = createRequire(join(root, "apps/desktop/package.json"))("electron");
const child = spawn(electron, [join(root, "apps/desktop")], {
  env: {
    ...process.env,
    PIG_DESKTOP_SMOKE: "1",
    PIG_DESKTOP_APPROVAL_SHOT: "1",
    PIG_DESKTOP_INSTANCE: `Pig Agent Approval ${process.pid}`,
    PIG_DESKTOP_USER_DATA: data,
    PIG_DESKTOP_DEBUG_SHOT_DIR: outDir,
  },
  stdio: "inherit",
});
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("Approval shot timed out"));
  }, 90000);
  child.once("exit", (status) => {
    clearTimeout(timer);
    resolve(status);
  });
});
const result = JSON.parse(await readFile(join(data, "smoke.json"), "utf8"));
if (code !== 0 || !result.ok) throw new Error(result.error || `Electron exit ${code}`);
console.log("Approval picker verified", result.approval);
