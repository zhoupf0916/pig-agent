// Builds src/pwa/sw.ts into dist/sw.js after the app bundle, baking in a build version and the entry assets
// the worker precaches. The version is a hash of every emitted file name (hashed), so any change ships a new worker.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin } from "vite";

export function pigServiceWorker(options: { root: string }): Plugin {
  let outDir = "";
  let precache: string[] = [];
  let version = "";
  return {
    name: "pig-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir.startsWith("/") ? config.build.outDir : join(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      const entry = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !item.isEntry) continue;
        entry.add(item.fileName);
        for (const file of item.imports) entry.add(file);
        for (const css of item.viteMetadata?.importedCss ?? []) entry.add(css);
      }
      precache = [...entry].filter((file) => file.startsWith("assets/")).map((file) => "/" + file).sort();
      version = createHash("sha256").update(Object.keys(bundle).sort().join("\n")).digest("hex").slice(0, 12);
    },
    async closeBundle() {
      const result = await build({
        configFile: false,
        logLevel: "warn",
        define: {
          __PIG_VERSION__: JSON.stringify(version),
          __PIG_PRECACHE__: JSON.stringify(precache),
        },
        build: {
          write: false,
          emptyOutDir: false,
          minify: true,
          lib: { entry: join(options.root, "src/pwa/sw.ts"), formats: ["iife"], name: "pigServiceWorker", fileName: () => "sw.js" },
        },
      });
      const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ type: string; code?: string }> }>;
      const code = outputs[0]?.output.find((item) => item.type === "chunk")?.code;
      if (!code) throw new Error("service worker build produced no code");
      await writeFile(join(outDir, "sw.js"), `/* pig-agent sw ${version} */\n${code}`);
    },
  };
}
