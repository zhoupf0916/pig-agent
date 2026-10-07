import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
// Resolve from the repo root regardless of the caller's cwd (e.g. `pnpm --filter @pig-agent/server start`).
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
await build({ absWorkingDir: root, entryPoints: [resolve(root, "apps/server/src/agent/file-helper.ts")], outfile: resolve(root, "native-dist/tools-helper.mjs"), bundle: true, platform: "node", target: "node22", format: "esm", banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"} });
console.log("Native file-tool helper built.");
