import { fileURLToPath } from "node:url";
import { build } from "esbuild";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await build({ entryPoints: ["apps/server/src/agent/file-helper.ts"], outfile: "native-dist/tools-helper.mjs", bundle: true, platform: "node", target: "node22", format: "esm", banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"} });
console.log("Native file-tool helper built.");
