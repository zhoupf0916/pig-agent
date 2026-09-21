/**
 * In-repo remote control-plane stub for smoke + pnpm test.
 * Start with: pnpm mock:cloud
 * Then Settings → 云端 → remote → http://127.0.0.1:8080
 *
 * Contract: POST /v1/runs (snapshot / repo hint) → GET …/events →
 * POST …/follow-ups | POST …/abort
 * Provider keys stay on the pig host; this process never needs them.
 */
import { startCloudControlStub } from "../agent/cloud/control-stub.ts";
import { resolveCloudRunsDir } from "../config.ts";

const PORT = Number(process.env.PIG_CLOUD_STUB_PORT ?? 8080);

const stub = await startCloudControlStub({
  port: PORT,
  runsRoot: resolveCloudRunsDir(),
});

console.log(`Pig cloud control stub  ${stub.url}`);
console.log("  POST /v1/runs");
console.log("  GET  /v1/runs/:id/events");
console.log("  POST /v1/runs/:id/follow-ups");
console.log("  POST /v1/runs/:id/abort");
console.log("Keys stay on the host. Point Settings cloudMode=remote at this origin.");
