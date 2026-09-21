import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const compose = [
  "compose",
  "--env-file",
  "data/cloud-local/stack.env",
  "-f",
  "infra/cloud/compose.yml",
];
function docker(args) {
  return execFileSync("docker", [...compose, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function sql(query) {
  return docker([
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
    query,
  ]);
}
async function api(
  path,
  { method = "GET", body, status = 200, key, token = env.MEMBER_TOKEN } = {},
) {
  const r = await fetch(`http://127.0.0.1:8890${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${r.status} ${r.status !== status ? await r.text() : ""}`,
  );
  return r.json();
}
assert.equal(
  Number(
    sql(
      "SELECT count(*) FROM runs WHERE state IN ('queued','preparing','running','cancelling')",
    ),
  ),
  0,
  "Run in an idle development stack",
);
assert.equal(
  Number(
    sql(
      "SELECT count(*) FROM schedules WHERE enabled AND cron IS NOT NULL AND deleted_at IS NULL",
    ),
  ),
  0,
  "Disable personal schedules before fault-injection smoke",
);
const created = [];
async function create(extra = {}) {
  const key = randomUUID();
  const body = {
    name: "自动验收定时计划",
    prompt: "在容器写入并读回验收文件",
    schedule: "@hourly",
    timezone: "Asia/Shanghai",
    ...extra,
  };
  const row = await api("/v1/schedules", {
    method: "POST",
    body,
    key,
    status: 201,
  });
  created.push(row.id);
  return { row, body, key };
}
async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Timed out");
}
async function tick(at) {
  const code = `const m=await import('./scheduler.mjs'); await Promise.all([m.tickSchedules(new Date(${JSON.stringify(at)})),m.tickSchedules(new Date(${JSON.stringify(at)}))]); process.exit(0);`;
  docker(["exec", "-T", "cloud", "node", "--input-type=module", "-e", code]);
}
const workerId = "schedule-policy-smoke";
// Claim with a dedicated test worker. Real worker is briefly drained, then restored.
const existingWorkers = (
  await api("/v1/admin/overview", { token: env.ADMIN_TOKEN })
).workers;
try {
  for (const w of existingWorkers)
    await api(`/v1/admin/workers/${encodeURIComponent(w.id)}`, {
      method: "PATCH",
      body: { enabled: false },
      token: env.ADMIN_TOKEN,
    });
  await api("/internal/claim", {
    method: "POST",
    body: { workerId },
    token: env.WORKER_TOKEN,
  });
  await api(`/v1/admin/workers/${workerId}`, {
    method: "PATCH",
    body: { capacity: 1, enabled: true },
    token: env.ADMIN_TOKEN,
  });
  await api(`/v1/admin/workers/${workerId}`, {
    method: "PATCH",
    body: { capacity: 3 },
    status: 403,
  });
  const jobs = await Promise.all(
    [1, 2].map((n) =>
      api("/v1/runs", {
        method: "POST",
        body: { prompt: `resource policy smoke ${n}` },
        status: 201,
      }),
    ),
  );
  const claims = await Promise.all(
    [1, 2].map(() =>
      api("/internal/claim", {
        method: "POST",
        body: { workerId },
        token: env.WORKER_TOKEN,
      }),
    ),
  );
  const claimed = claims.filter(Boolean);
  assert.equal(
    claimed.length,
    1,
    "control plane enforces capacity despite concurrent claims",
  );
  await api(`/internal/runs/${claimed[0].id}/finish`, {
    method: "POST",
    body: {
      token: claimed[0].token,
      ok: false,
      error: "policy smoke completed",
    },
    token: env.WORKER_TOKEN,
  });
  await api(`/v1/admin/workers/${workerId}`, {
    method: "PATCH",
    body: { enabled: false },
    token: env.ADMIN_TOKEN,
  });
  assert.equal(
    await api("/internal/claim", {
      method: "POST",
      body: { workerId },
      token: env.WORKER_TOKEN,
    }),
    null,
  );
  for (const job of jobs)
    await api(`/v1/runs/${job.id}/abort`, { method: "POST" });
  console.log(
    "PASS: control-plane capacity, concurrent claims, node drain and admin authorization",
  );
} finally {
  for (const w of existingWorkers)
    await api(`/v1/admin/workers/${encodeURIComponent(w.id)}`, {
      method: "PATCH",
      body: { enabled: w.enabled, capacity: Math.min(w.capacity, 3) },
      token: env.ADMIN_TOKEN,
    });
  sql("DELETE FROM workers WHERE id='schedule-policy-smoke'");
}
try {
  const { row, body, key } = await create();
  assert.equal(
    (await api("/v1/schedules", { method: "POST", body, key, status: 201 })).id,
    row.id,
  );
  await api("/v1/schedules", {
    method: "POST",
    body: { ...body, prompt: "changed" },
    key,
    status: 409,
  });
  for (const suffix of ["", "/history"])
    await api(`/v1/schedules/${row.id}${suffix}`, {
      token: env.MEMBER2_TOKEN,
      status: 404,
    });
  await api(`/v1/schedules/${row.id}`, {
    method: "PATCH",
    body: { enabled: false },
    token: env.MEMBER2_TOKEN,
    status: 404,
  });
  await api(`/v1/schedules/${row.id}/run`, {
    method: "POST",
    key: randomUUID(),
    token: env.MEMBER2_TOKEN,
    status: 404,
  });
  await api("/v1/schedules", {
    method: "POST",
    key: randomUUID(),
    body: { ...body, timezone: "invalid" },
    status: 400,
  });
  await api(`/v1/schedules/${row.id}`, {
    method: "PATCH",
    body: { schedule: "* * * * * *" },
    status: 400,
  });
  const due = new Date(Date.now() + 600000).toISOString();
  sql(`UPDATE schedules SET next_fire_at='${due}' WHERE id='${row.id}'`);
  await tick(new Date(new Date(due).getTime() + 1000).toISOString());
  let history = await api(`/v1/schedules/${row.id}/history`);
  assert.equal(history.firings.length, 1);
  assert.equal(history.runs.length, 1);
  await tick(new Date(new Date(due).getTime() + 1000).toISOString());
  assert.equal((await api(`/v1/schedules/${row.id}/history`)).runs.length, 1);
  const run = history.runs[0];
  await until(async () => {
    const r = await api(`/v1/runs/${run.id}`);
    assert.notEqual(r.state, "failed", r.error);
    return r.state === "succeeded";
  });
  assert.ok(
    (await api(`/v1/runs/${run.id}/artifacts`)).artifacts.some(
      (f) => f.path === "cloud-proof.txt",
    ),
  );
  console.log(
    "PASS: timezone validation, owner isolation, idempotency, concurrent durable firing and container artifact",
  );

  const skip = (await create({ misfirePolicy: "skip" })).row;
  const once = (await create({ misfirePolicy: "once" })).row;
  const future = new Date(Date.now() + 86400000).toISOString();
  for (const r of [skip, once])
    sql(`UPDATE schedules SET next_fire_at='${due}' WHERE id='${r.id}'`);
  // Keep earlier schedule out of this simulated tick.
  await api(`/v1/schedules/${row.id}`, {
    method: "PATCH",
    body: { enabled: false },
  });
  await tick(future);
  assert.equal((await api(`/v1/schedules/${skip.id}/history`)).runs.length, 0);
  assert.equal((await api(`/v1/schedules/${once.id}/history`)).runs.length, 1);
  await api(`/v1/schedules/${skip.id}`, {
    method: "PATCH",
    body: { enabled: false },
  });
  await api(`/v1/schedules/${once.id}`, {
    method: "PATCH",
    body: { enabled: false },
  });
  console.log("PASS: skip / catch-up once and persisted disable");

  const manual = (await create({ schedule: null })).row;
  const manualKey = randomUUID();
  const first = await api(`/v1/schedules/${manual.id}/run`, {
    method: "POST",
    key: manualKey,
    status: 202,
  });
  assert.equal(
    (
      await api(`/v1/schedules/${manual.id}/run`, {
        method: "POST",
        key: manualKey,
        status: 202,
      })
    ).remoteRunId,
    first.remoteRunId,
  );
  const active = await api(`/v1/runs/${first.remoteRunId}`);
  if (["queued", "preparing", "running"].includes(active.state))
    await api(`/v1/schedules/${manual.id}/run`, {
      method: "POST",
      key: randomUUID(),
      status: 409,
    });
  await until(async () =>
    ["succeeded", "failed", "cancelled"].includes(
      (await api(`/v1/runs/${first.remoteRunId}`)).state,
    ),
  );
  console.log("PASS: manual-run deduplication and no overlap");

  const restart = (await create({ misfirePolicy: "once" })).row;
  sql(
    `UPDATE schedules SET next_fire_at=now()+interval '5 seconds' WHERE id='${restart.id}'`,
  );
  docker(["restart", "-t", "1", "cloud"]);
  await until(async () => {
    try {
      return (
        (await api(`/v1/schedules/${restart.id}/history`)).runs.length === 1
      );
    } catch {
      return false;
    }
  });
  history = await api(`/v1/schedules/${restart.id}/history`);
  await until(async () => {
    const r = await api(`/v1/runs/${history.runs[0].id}`);
    assert.notEqual(r.state, "failed", r.error);
    return r.state === "succeeded";
  });
  await api(`/v1/schedules/${restart.id}`, {
    method: "PATCH",
    body: { enabled: false },
  });
  console.log(
    "PASS: control-plane restart triggers scheduled container execution with no Web / Electron process involved",
  );
} finally {
  for (const id of created)
    await api(`/v1/schedules/${id}`, { method: "DELETE" }).catch(() => {});
}
