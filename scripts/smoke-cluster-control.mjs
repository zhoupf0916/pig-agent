import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const env = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const bases = ["http://127.0.0.1:8893", "http://127.0.0.1:8894"];
let turn = 0;
async function req(
  path,
  {
    body,
    method = body ? "POST" : "GET",
    token = env.ADMIN_TOKEN,
    status = 200,
    base = bases[turn++ % 2],
    key = randomUUID(),
  } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  assert.equal(
    response.status,
    status,
    `${path}: ${await (response.status !== status ? response.clone().text() : Promise.resolve(""))}`,
  );
  return response.json();
}
const sql = (statement) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "data/cluster-local/stack.env",
      "-f",
      "infra/cluster/compose.yml",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "pig",
      "-d",
      "pig",
      "-At",
      "-c",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
const record = (name, detail) => {
  evidence.push({ name, detail, at: new Date().toISOString() });
  console.log("PASS", name, detail || "");
};
const jobs = [];
const attempts = [];
const fixtures = [];
const initialWorkers = (await req("/v1/admin/overview")).workers;
const originalPolicy = await req("/v1/admin/execution-policy");
const limits = {
  ...originalPolicy,
  globalConcurrency: 2,
  userConcurrency: 1,
  projectConcurrency: 1,
  queueLimit: 200,
  queueTimeoutSeconds: 3600,
};
async function setPolicy(p) {
  Object.assign(limits, p);
  return req("/v1/admin/execution-policy", { method: "PUT", body: limits });
}
async function create(token = env.MEMBER_TOKEN, extra = {}) {
  const r = await req("/v1/runs", {
    token,
    body: { prompt: "Isolated cluster control acceptance", ...extra },
    status: 201,
  });
  jobs.push(r.id);
  return r;
}
async function register(workerId, capacity = 2) {
  const w = { workerId, instanceId: randomUUID() };
  await req("/internal/workers/register", {
    token: env.WORKER_TOKEN,
    body: { ...w, capacity, profiles: ["compact", "standard", "large"] },
  });
  await req("/v1/admin/workers/" + workerId, {
    method: "PATCH",
    body: { enabled: true, capacity },
  });
  fixtures.push(w);
  return w;
}
async function claim(w) {
  const a = await req("/internal/claim", { token: env.WORKER_TOKEN, body: w });
  if (a) attempts.push(a);
  return a;
}
async function finish(a) {
  await req(`/internal/runs/${a.id}/finish`, {
    token: env.WORKER_TOKEN,
    body: { token: a.token, ok: false, error: "Acceptance fixture complete" },
  });
}
async function cleanupJobs() {
  for (const id of jobs) {
    const r = await req("/v1/runs/" + id);
    if (["queued", "preparing", "running"].includes(r.state))
      await req(`/v1/runs/${id}/abort`, { body: {} });
  }
  for (const a of attempts) {
    const r = await req("/v1/runs/" + a.id);
    if (r.state === "cancelling") await finish(a);
  }
  jobs.length = 0;
  attempts.length = 0;
}
async function terminal(id) {
  for (let i = 0; i < 80; i++) {
    const r = await req("/v1/runs/" + id);
    if (["failed", "succeeded", "cancelled"].includes(r.state)) return r;
    await wait(150);
  }
  throw Error("terminal timeout " + id);
}
try {
  assert.equal(
    (await req("/health")).modelMode,
    "mock",
    "Only isolated mock environment is supported",
  );
  for (const w of initialWorkers) {
    assert.equal(w.active, 0, "Do not interrupt unrelated active work");
    await req("/v1/admin/workers/" + w.id, {
      method: "PATCH",
      body: { enabled: false },
    });
  }
  let w1 = await register("acceptance-node-a"),
    w2 = await register("acceptance-node-b");
  await setPolicy({});
  await req("/v1/admin/execution-policy", {
    token: env.MEMBER_TOKEN,
    method: "PUT",
    body: limits,
    status: 403,
  });
  await req("/v1/admin/execution-policy", {
    method: "PUT",
    body: { ...limits, globalConcurrency: 0 },
    status: 400,
  });
  assert.deepEqual(await req("/v1/admin/execution-policy"), limits);
  const duplicateKey = randomUUID();
  const replay = await Promise.all(
    bases.map(async (base) => {
      const response = await fetch(base + "/v1/runs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MEMBER_TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": duplicateKey,
        },
        body: JSON.stringify({ prompt: "Idempotent cluster submission" }),
        signal: AbortSignal.timeout(12000),
      });
      const body = await response.json();
      if (body.id) jobs.push(body.id);
      return { status: response.status, body };
    }),
  );
  assert.deepEqual(
    replay.map((r) => r.status).sort(),
    [200, 201],
    "Exactly one creation and one replay are required",
  );
  assert.equal(replay[0].body.id, replay[1].body.id);
  await cleanupJobs();
  record(
    "durable settings and duplicate submissions",
    "invalid/member settings rejected; same key across controls creates one run",
  );
  await Promise.all([
    create(),
    create(),
    create(env.MEMBER2_TOKEN),
    create(env.MEMBER2_TOKEN),
  ]);
  const claims = (
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => claim(i % 2 ? w1 : w2)),
    )
  ).filter(Boolean);
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((a) => a.id)).size, 2);
  assert.equal(
    new Set(
      await Promise.all(
        claims.map(async (a) => (await req("/v1/runs/" + a.id)).owner_id),
      ),
    ).size,
    2,
  );
  record(
    "two-control concurrent claims, global=2, user=1",
    "12 competing requests, 2 unique attempts across 2 owners",
  );
  const a = claims[0];
  await req(`/internal/runs/${a.id}/start`, {
    token: env.WORKER_TOKEN,
    body: { token: a.token },
  });
  const event = { type: "message", content: "cross instance evidence" };
  for (const base of bases)
    await req(`/internal/runs/${a.id}/event`, {
      base,
      token: env.WORKER_TOKEN,
      body: { token: a.token, event, eventId: "acceptance:1" },
    });
  assert.equal(
    (await req(`/v1/runs/${a.id}/eventlog`)).events.filter(
      (e) => e.event.content === "cross instance evidence",
    ).length,
    1,
  );
  record(
    "cross-control event persistence and idempotency",
    "one event for two deliveries",
  );
  await req(`/v1/runs/${a.id}/abort`, { body: {} });
  await finish(a);
  assert.equal((await req("/v1/runs/" + a.id)).state, "cancelled");
  const other = claims[1];
  const owner = (await req("/v1/runs/" + other.id)).worker_id;
  const old = owner === w1.workerId ? w1 : w2;
  const newer = await register(owner);
  await req("/internal/workers/heartbeat", {
    token: env.WORKER_TOKEN,
    body: old,
    status: 409,
  });
  await req(`/internal/runs/${other.id}/start`, {
    token: env.WORKER_TOKEN,
    body: { token: other.token },
    status: 409,
  });
  await req(`/internal/runs/${other.id}/finish`, {
    token: env.WORKER_TOKEN,
    body: { token: other.token, ok: true },
    status: 409,
  });
  if (owner === w1.workerId) w1 = newer;
  else w2 = newer;
  assert.equal((await req("/v1/runs/" + other.id)).state, "failed");
  record(
    "cancel and process-generation fencing",
    "late start, finish, and old heartbeat rejected",
  );
  await cleanupJobs();
  await setPolicy({ globalConcurrency: 2, userConcurrency: 4 });
  await create();
  await create();
  await create();
  await create(env.MEMBER2_TOKEN);
  const fairClaims = (await Promise.all([claim(w1), claim(w2)])).filter(
    Boolean,
  );
  assert.equal(fairClaims.length, 2);
  assert.equal(
    new Set(
      await Promise.all(
        fairClaims.map(async (a) => (await req("/v1/runs/" + a.id)).owner_id),
      ),
    ).size,
    2,
  );
  record(
    "owner fairness without a restrictive user cap",
    "owner with three queued jobs cannot monopolize both slots ahead of another owner",
  );
  await cleanupJobs();
  await setPolicy({ globalConcurrency: 4, userConcurrency: 4 });
  await req("/v1/admin/workers/" + w1.workerId, {
    method: "PATCH",
    body: { capacity: 1 },
  });
  await create();
  await create();
  await create();
  assert.ok(await claim(w1));
  assert.equal(await claim(w1), null);
  assert.ok(await claim(w2));
  record(
    "per Runner capacity",
    "configured capacity 1 cannot claim a second task",
  );
  await cleanupJobs();
  await req("/internal/workers/heartbeat", {
    token: env.WORKER_TOKEN,
    body: { ...w1, draining: true },
  });
  await create();
  assert.equal(await claim(w1), null);
  await req("/internal/workers/heartbeat", {
    token: env.WORKER_TOKEN,
    body: { ...w1, draining: false },
  });
  assert.ok(await claim(w1));
  await cleanupJobs();
  w2 = await register(w2.workerId, 1);
  await req("/v1/admin/workers/" + w2.workerId, {
    method: "PATCH",
    body: { capacity: 16 },
  });
  await create();
  await create();
  assert.ok(await claim(w2));
  assert.equal(await claim(w2), null);
  await cleanupJobs();
  w2 = await register(w2.workerId, 2);
  const limited = { ...w1, instanceId: randomUUID() };
  await req("/internal/workers/register", {
    token: env.WORKER_TOKEN,
    body: { ...limited, capacity: 2, profiles: ["compact"] },
  });
  w1 = limited;
  await create();
  assert.equal(await claim(w1), null);
  await cleanupJobs();
  w1 = await register(w1.workerId, 2);
  record(
    "Runner draining, advertised capacity and capabilities",
    "draining cannot claim; hardware capacity beats admin value; incompatible profile stays queued",
  );
  const space = await req("/v1/spaces", {
    token: env.MEMBER_TOKEN,
    body: { name: "Cluster acceptance " + randomUUID() },
    status: 201,
  });
  const project = await req("/v1/shared-projects", {
    token: env.MEMBER_TOKEN,
    body: { spaceId: space.id, name: "Concurrent project" },
    status: 201,
  });
  const invite = await req(`/v1/spaces/${space.id}/invitations`, {
    token: env.MEMBER_TOKEN,
    body: { role: "editor" },
    status: 201,
  });
  await req("/v1/spaces/join", {
    token: env.MEMBER2_TOKEN,
    body: { invite: invite.invite },
  });
  await create(env.MEMBER_TOKEN, { projectId: project.id });
  await create(env.MEMBER2_TOKEN, { projectId: project.id });
  assert.equal(
    (await Promise.all([claim(w1), claim(w2)])).filter(Boolean).length,
    1,
  );
  record(
    "shared project capacity",
    "two owners cannot exceed project concurrency 1",
  );
  await cleanupJobs();
  const approvalRun = await create(env.MEMBER_TOKEN, { requireApproval: true });
  const approvalAttempt = await claim(w1);
  assert.equal(approvalAttempt.id, approvalRun.id);
  await req(`/internal/runs/${approvalRun.id}/start`, {
    token: env.WORKER_TOKEN,
    body: { token: approvalAttempt.token },
  });
  const approval = await req("/internal/approvals", {
    token: env.WORKER_TOKEN,
    body: {
      token: approvalAttempt.token,
      callId: "approval-retry",
      tool: "write_file",
      args: { path: "result.txt", content: "test" },
    },
    status: 201,
  });
  await req(`/v1/runs/${approvalRun.id}/approvals/${approval.id}/decision`, {
    token: env.MEMBER_TOKEN,
    body: { decision: "approve" },
  });
  const receipt = randomUUID();
  for (const base of bases)
    assert.equal(
      (
        await req(`/internal/approvals/${approval.id}/poll`, {
          base,
          token: env.WORKER_TOKEN,
          body: { token: approvalAttempt.token, requestId: receipt },
        })
      ).state,
      "approved",
    );
  assert.equal(
    (
      await req(`/internal/approvals/${approval.id}/poll`, {
        token: env.WORKER_TOKEN,
        body: { token: approvalAttempt.token, requestId: randomUUID() },
      })
    ).state,
    "consumed",
  );
  assert.equal(
    (
      await req(`/internal/approvals/${approval.id}/poll`, {
        token: env.WORKER_TOKEN,
        body: { token: approvalAttempt.token },
      })
    ).state,
    "consumed",
  );
  record(
    "approval receipt retry fencing",
    "same receipt across controls recovers granted authorization; different and legacy receipt cannot replay",
  );
  await cleanupJobs();
  await setPolicy({ queueLimit: 1, queueTimeoutSeconds: 30 });
  const queued = await create();
  await req("/v1/runs", {
    token: env.MEMBER2_TOKEN,
    body: { prompt: "Must be rejected" },
    status: 429,
  });
  sql(
    `UPDATE runs SET created_at=now()-interval '31 seconds' WHERE id='${queued.id}'`,
  );
  assert.equal((await terminal(queued.id)).state, "failed");
  record(
    "queue backpressure and expiry",
    "queue limit 1 rejects second submission; aged task fails durably",
  );
  await cleanupJobs();
  await setPolicy({ queueLimit: 200 });
  const timeout = await create();
  const ta = await claim(w1);
  assert.equal(ta.id, timeout.id);
  sql(
    `UPDATE runs SET deadline_at=now()-interval '1 second' WHERE id='${ta.id}'`,
  );
  assert.equal(
    (
      await req(`/internal/runs/${ta.id}/heartbeat`, {
        token: env.WORKER_TOKEN,
        body: { token: ta.token },
      })
    ).state,
    "expired",
  );
  assert.equal((await terminal(ta.id)).state, "failed");
  record(
    "authoritative execution deadline",
    "live lease cannot extend expired execution deadline",
  );
  await cleanupJobs();
  const lost = await create();
  const la = await claim(w2);
  assert.equal(la.id, lost.id);
  sql(
    `UPDATE runs SET lease_until=now()-interval '1 second' WHERE id='${la.id}'`,
  );
  assert.equal((await terminal(la.id)).state, "failed");
  await req(`/internal/runs/${la.id}/event`, {
    token: env.WORKER_TOKEN,
    body: { token: la.token, event },
    status: 409,
  });
  record(
    "lost node lease and stale operation",
    "expired attempt failed without automatic replay",
  );
  await cleanupJobs();
  const schedule = await req("/v1/schedules", {
    token: env.MEMBER_TOKEN,
    body: {
      name: "Cluster single firing",
      prompt: "One durable firing",
      schedule: "0 0 1 1 *",
      timezone: "UTC",
      misfirePolicy: "once",
    },
    status: 201,
  });
  sql(
    `UPDATE schedules SET next_fire_at=now()-interval '1 second' WHERE id='${schedule.id}'`,
  );
  for (
    let i = 0;
    i < 40 &&
    !Number(
      sql(`SELECT count(*) FROM runs WHERE schedule_id='${schedule.id}'`),
    );
    i++
  )
    await wait(150);
  assert.equal(
    Number(sql(`SELECT count(*) FROM runs WHERE schedule_id='${schedule.id}'`)),
    1,
  );
  await req(`/v1/schedules/${schedule.id}`, {
    token: env.MEMBER_TOKEN,
    method: "PATCH",
    body: { enabled: false },
  });
  jobs.push(sql(`SELECT id FROM runs WHERE schedule_id='${schedule.id}'`));
  record("two scheduler instances", "one unique firing and one queued run");
  await cleanupJobs();
  const durable = await create();
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "data/cluster-local/stack.env",
      "-f",
      "infra/cluster/compose.yml",
      "restart",
      "cloud-a",
    ],
    { stdio: "pipe" },
  );
  assert.equal(
    (await req("/v1/runs/" + durable.id, { base: bases[1] })).state,
    "queued",
  );
  for (let i = 0; i < 80; i++) {
    try {
      await req("/health", { base: bases[0] });
      break;
    } catch {
      await wait(200);
    }
  }
  assert.equal(
    (await req("/v1/runs/" + durable.id, { base: bases[0] })).state,
    "queued",
  );
  assert.deepEqual(
    await req("/v1/admin/execution-policy", { base: bases[0] }),
    limits,
  );
  record(
    "control instance restart",
    "other control retains service; queued state survives",
  );
  await cleanupJobs();
} finally {
  await cleanupJobs().catch((e) => console.error("cleanup:", e.message));
  for (const w of fixtures)
    await req("/v1/admin/workers/" + w.workerId, {
      method: "PATCH",
      body: { enabled: false },
    }).catch(() => {});
  await req("/v1/admin/execution-policy", {
    method: "PUT",
    body: originalPolicy,
  });
  for (const w of initialWorkers)
    await req("/v1/admin/workers/" + w.id, {
      method: "PATCH",
      body: { enabled: w.enabled, capacity: w.capacity },
    });
  await mkdir("data/cluster-local/evidence", { recursive: true });
  await writeFile(
    "data/cluster-local/evidence/control.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment:
          "isolated local Docker, two control instances, simulated registered workers for deterministic protocol races",
        passed: evidence.length,
        evidence,
      },
      null,
      2,
    ),
  );
}
console.log(`Cluster control acceptance passed: ${evidence.length} scenarios`);
