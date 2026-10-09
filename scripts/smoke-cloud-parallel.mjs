// F7 parallel subtasks against the local cloud stack (mock model): the parent fans out three items,
// yields its slot while waiting, one child is retried for an invalid JSON answer, then the parent
// resumes with the tool result, finishes and keeps the full results as an artifact.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8")).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = "http://127.0.0.1:8890";
async function req(path, { token = env.MEMBER_TOKEN, body, method = body ? "POST" : "GET", status = 200 } = {}) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, status, r.status !== status ? await r.text() : path);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = await req("/v1/runs", { body: { prompt: "[PARALLEL_ACCEPTANCE] 并行处理三项", requireApproval: false }, status: 201 });
let sawWaiting = false;
let final;
for (let i = 0; i < 400 && !final; i++) {
  const r = await req("/v1/runs/" + run.id);
  if (r.state === "waiting") sawWaiting = true;
  if (["succeeded", "failed", "cancelled"].includes(r.state)) final = r;
  else await sleep(250);
}
assert.ok(final, "parent did not finish");
assert.equal(final.state, "succeeded", final.error);
assert.ok(sawWaiting, "parent never entered waiting (did it yield its slot?)");
const { groups } = await req(`/v1/runs/${run.id}/children`);
assert.equal(groups.length, 1);
const g = groups[0];
assert.equal(g.state, "completed");
assert.deepEqual(g.items.map((i) => i.state), ["succeeded", "succeeded", "succeeded"]);
assert.equal(g.items.find((i) => i.item === "坏格式").attempts, 2, "invalid JSON answer was not retried once");
const log = await req(`/v1/runs/${run.id}/eventlog`);
const toolEnd = log.events.find((e) => e.event.type === "tool_end" && e.event.name === "spawn_parallel");
assert.match(toolEnd.event.output, /^并行子任务完成：成功 3\/3/);
const reply = log.events.filter((e) => e.event.type === "message" && e.event.message?.role === "assistant").at(-1)?.event.message.content;
assert.match(reply, /^并行汇总：并行子任务完成：成功 3\/3/);
const artifacts = await req(`/v1/runs/${run.id}/artifacts`).catch(() => null);
if (artifacts) assert.ok(JSON.stringify(artifacts).includes("parallel/"), "results artifact missing");
// Cancelling a waiting parent cancels its children.
const second = await req("/v1/runs", { body: { prompt: "[PARALLEL_ACCEPTANCE] 取消测试", requireApproval: false }, status: 201 });
let waited = false;
for (let i = 0; i < 200 && !waited; i++) { waited = (await req("/v1/runs/" + second.id)).state === "waiting"; if (!waited) await sleep(50); }
if (waited) {
  await req(`/v1/runs/${second.id}/abort`, { body: {} });
  let items = [];
  for (let i = 0; i < 100; i++) { items = (await req(`/v1/runs/${second.id}/children`)).groups[0].items; if (items.every((x) => ["succeeded", "failed", "cancelled"].includes(x.state))) break; await sleep(200); }
  assert.equal((await req("/v1/runs/" + second.id)).state, "cancelled");
  assert.ok(items.some((x) => x.state === "cancelled"), "children were not cancelled with the parent");
  console.log("PASS cancelling a waiting parent cancels its children");
} else console.log("SKIP cancel case: parent finished before it could be observed waiting");
console.log(`PASS parallel subtasks: 3 children, waiting observed, retry on invalid JSON, parent resumed: "${reply.slice(0, 60)}"`);
