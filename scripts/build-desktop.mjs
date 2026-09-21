import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
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
await cp("apps/web/dist", `${runtime}/web/dist`, { recursive: true });
await cp("skills", `${runtime}/skills`, { recursive: true });
console.log("Desktop runtime bundled (UI, server, built-in skills only).");
