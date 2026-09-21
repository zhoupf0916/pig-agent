import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
const env = parseEnv(await readFile("data/cluster-local/stack.env", "utf8"));
let count = 0;
async function api(
  path,
  body,
  {
    token = env.WORKER_TOKEN,
    method = body ? "POST" : "GET",
    status = path === "/v1/runs" && body ? 201 : 200,
  } = {},
) {
  const r = await fetch(
    ["http://127.0.0.1:8893", "http://127.0.0.1:8894"][count++ % 2] + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  assert.equal(
    r.status,
    status,
    `${path}: ${await (r.status === status ? Promise.resolve("") : r.clone().text())}`,
  );
  return r.json();
}
const admin = (path, body, method) =>
  api(path, body, { token: env.ADMIN_TOKEN, method });
assert.equal((await admin("/health")).modelMode, "mock");
const overview = await admin("/v1/admin/overview");
assert(
  overview.workers.every((w) => w.active === 0),
  "Cluster must be idle",
);
const a = {
    workerId: "acceptance-durable-delivery",
    instanceId: randomUUID(),
    capacity: 1,
    profiles: ["compact", "standard", "large"],
  },
  b = { ...a, instanceId: randomUUID() };
const checks = [];
try {
  for (const w of overview.workers)
    if (w.enabled)
      await admin("/v1/admin/workers/" + w.id, { enabled: false }, "PATCH");
  await api("/internal/workers/register", a);
  await api("/internal/workers/register", a);
  await api("/internal/workers/register", b);
  await admin("/v1/admin/workers/" + b.workerId, { enabled: true }, "PATCH");
  const create = async () => {
    const run = await admin("/v1/runs", {
      prompt: "Completion receipt acceptance fixture",
    });
    const job = await api("/internal/claim", {
      workerId: b.workerId,
      instanceId: b.instanceId,
    });
    assert.equal(job.id, run.id);
    return job;
  };
  let job = await create();
  await api("/internal/workers/register", a, { status: 409 });
  await api("/internal/workers/heartbeat", {
    workerId: b.workerId,
    instanceId: b.instanceId,
  });
  assert.equal((await admin("/v1/runs/" + job.id)).state, "preparing");
  checks.push(
    "A registration replay after B cannot replace B or invalidate its active run",
  );
  let payload = {
    token: job.token,
    submissionId: randomUUID(),
    ok: true,
    snapshot: { encoding: "tar.gz", data: "", files: [], byteSize: 0 },
    files: [{ path: "receipt-proof.txt", content: "RECEIPT_ONCE" }],
  };
  const replies = await Promise.all([
    api(`/internal/runs/${job.id}/finish`, payload),
    api(`/internal/runs/${job.id}/finish`, payload),
  ]);
  assert(replies.every((r) => r.ok));
  assert(replies.some((r) => r.replayed));
  await api(
    `/internal/runs/${job.id}/finish`,
    { ...payload, ok: false },
    { status: 409 },
  );
  await api(
    `/internal/runs/${job.id}/finish`,
    { ...payload, token: "wrong-token" },
    { status: 409 },
  );
  const artifacts = (await admin(`/v1/runs/${job.id}/artifacts`)).artifacts;
  assert.equal(artifacts.length, 1);
  checks.push(
    "Concurrent completion across two control planes writes one artifact; exact replay succeeds; changed payload and wrong token rejected",
  );
  job = await create();
  payload = {
    token: job.token,
    submissionId: randomUUID(),
    ok: true,
    snapshot: { encoding: "tar.gz", data: "", files: [], byteSize: 0 },
    files: [{ path: "race.txt", content: "ONCE" }],
  };
  await Promise.all([
    api(`/internal/runs/${job.id}/finish`, payload),
    admin(`/v1/runs/${job.id}/abort`, {}),
  ]);
  const race = await admin("/v1/runs/" + job.id);
  assert(["cancelled", "succeeded"].includes(race.state));
  const replay = await api(`/internal/runs/${job.id}/finish`, payload);
  assert.equal(replay.state, race.state);
  assert.equal(
    (await admin(`/v1/runs/${job.id}/artifacts`)).artifacts.length,
    1,
  );
  checks.push(
    "Concurrent cancellation and finish serialize; replay preserves winning terminal state and single artifact",
  );
  job = await create();
  await admin(`/v1/runs/${job.id}/abort`, {});
  payload = {
    token: job.token,
    submissionId: randomUUID(),
    ok: true,
    snapshot: { encoding: "tar.gz", data: "", files: [], byteSize: 0 },
    files: [],
  };
  assert.equal(
    (await api(`/internal/runs/${job.id}/finish`, payload)).state,
    "cancelled",
  );
  checks.push("Cancel before completion cannot become succeeded");
  const c = { ...b, instanceId: randomUUID() },
    d = { ...b, instanceId: randomUUID() };
  await Promise.all([
    api("/internal/workers/register", c),
    api("/internal/workers/register", d),
  ]);
  const workers = (await admin("/v1/admin/overview")).workers;
  const current = workers.find((w) => w.id === b.workerId).instance_id;
  await api("/internal/workers/register", current === c.instanceId ? d : c, {
    status: 409,
  });
  checks.push(
    "Concurrent replacements have one winner; superseded generation cannot return",
  );
  await mkdir("data/acceptance-redesign", { recursive: true });
  await writeFile(
    "data/acceptance-redesign/completion-fencing.json",
    JSON.stringify({ at: new Date().toISOString(), checks }, null, 2),
  );
  console.log(checks.join("\n"));
} finally {
  await admin(
    "/v1/admin/workers/" + a.workerId,
    { enabled: false },
    "PATCH",
  ).catch(() => {});
  for (const w of overview.workers)
    if (w.enabled)
      await admin("/v1/admin/workers/" + w.id, { enabled: true }, "PATCH");
}
