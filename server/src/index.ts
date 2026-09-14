import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAutomationScheduler } from "./automations/scheduler.ts";
import { createApp } from "./app.ts";
import { PORT, PROJECT_ROOT } from "./config.ts";

process.chdir(PROJECT_ROOT);

const app = createApp();
startAutomationScheduler();
const webDist = resolve(PROJECT_ROOT, "web/dist");

if (existsSync(webDist)) {
  const rel = "web/dist";
  app.use("/*", serveStatic({ root: rel }));
  app.get("*", serveStatic({ root: rel, path: "index.html" }));
}

serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: "127.0.0.1",
  },
  (info) => {
    const here = dirname(fileURLToPath(import.meta.url));
    console.log(`Pig Agent API  http://127.0.0.1:${info.port}`);
    console.log(`UI (dev)       http://127.0.0.1:5173`);
    if (existsSync(webDist)) {
      console.log(`UI (static)    http://127.0.0.1:${info.port}`);
    }
    console.log(`cwd            ${here}`);
  },
);
