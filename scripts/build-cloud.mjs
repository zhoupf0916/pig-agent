import { build } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
await rm("cloud-dist", { recursive: true, force: true });
await mkdir("cloud-dist", { recursive: true });
for (const [name, entry] of Object.entries({
  cloud: "apps/cloud/src/index.ts",
  scheduler: "apps/cloud/src/schedules.ts",
  gateway: "apps/cloud/src/gateway.ts",
  worker: "apps/worker/src/index.ts",
  runner: "apps/server/src/cloud-runner.ts",
})) {
  await build({
    entryPoints: [entry],
    outfile: `cloud-dist/${name}.mjs`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["pg-native"],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
}
await cp("skills", "cloud-dist/skills", { recursive: true });
await cp("apps/web/dist", "cloud-dist/web", { recursive: true });
await cp("apps/admin/public", "cloud-dist/admin", { recursive: true });
console.log(
  "Cloud, gateway, worker and existing Pig runner bundled. No local data or credentials included.",
);
