import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
const runtime = "desktop-dist/runtime";
await rm("desktop-dist", { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["apps/server/src/desktop.ts"],
  outfile: `${runtime}/server.mjs`,
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ["apps/server/src/agent/file-helper.ts"],
  outfile: `${runtime}/tools-helper.mjs`, platform: "node", target: "node22", format: "esm", bundle: true,
  banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
});
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const source = require("../apps/desktop/src/computer-native.cjs");
  const sourcePath = `${runtime}/computer-helper.swift`;
  await writeFile(sourcePath, source);
  await promisify(execFile)(
    "/usr/bin/xcrun",
    ["swiftc", sourcePath, "-o", `${runtime}/computer-helper`],
    { timeout: 120000 },
  );
  await chmod(`${runtime}/computer-helper`, 0o755);
  await rm(sourcePath);
}
await cp("apps/web/dist", `${runtime}/web/dist`, { recursive: true });
await cp("skills", `${runtime}/skills`, { recursive: true });
console.log("Desktop runtime bundled (UI, server, built-in skills only).");
