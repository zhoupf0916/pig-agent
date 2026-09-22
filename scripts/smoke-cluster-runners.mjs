import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
const env = parseEnv(await readFile("data/cluster-local/stack.env", "utf8"));
const base = "http://127.0.0.1:8892";
const started = Date.now(),
  evidence = [],
  runs = [];
function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}
function compose(args) {
  return docker([
    "compose",
    "--env-file",
    "data/cluster-local/stack.env",
    "-f",
    "infra/cluster/compose.yml",
    ...args,
  ]);
}
async function req(path, body, token = env.ADMIN_TOKEN) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(r.ok, `${path}: HTTP ${r.status}`);
  return r.json();
}
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("Timeout: " + label);
}
async function create(token) {
  const r = await req(
    "/v1/runs",
    {
      prompt: "Cluster real Runner acceptance: write and read cloud-proof.txt",
      requireApproval: true,
    },
    token,
  );
  runs.push(r.id);
  return r.id;
}
const state = (id) => req("/v1/runs/" + id);
const pending = (id) =>
  req(`/v1/runs/${id}/approvals`).then((d) =>
    d.approvals.find((a) => a.state === "pending"),
  );
const terminal = (r) => ["succeeded", "failed", "cancelled"].includes(r.state);
const old = await req("/v1/admin/execution-policy");
async function policy(value) {
  const r = await fetch(base + "/v1/admin/execution-policy", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  assert.ok(r.ok);
}
try {
  await policy({ ...old, globalConcurrency: 4, userConcurrency: 2 });
  const batch = await Promise.all([
    create(env.MEMBER_TOKEN),
    create(env.MEMBER_TOKEN),
    create(env.MEMBER2_TOKEN),
    create(env.MEMBER2_TOKEN),
  ]);
  await until(async () => {
    const p = await Promise.all(batch.map(pending));
    return p.every(Boolean);
  }, "four native Runner processes waiting for approval");
  const assigned = await Promise.all(batch.map(state));
  assert.equal(new Set(assigned.map((r) => r.worker_id)).size, 2);
  const listed =
    docker([
      "ps",
      "-q",
      "--filter",
      "label=pig-agent.worker=pig-cluster-runner-a",
    ])
      .split("\n")
      .filter(Boolean).length +
    docker([
      "ps",
      "-q",
      "--filter",
      "label=pig-agent.worker=pig-cluster-runner-b",
    ])
      .split("\n")
      .filter(Boolean).length;
  assert.equal(listed, 0, "tasks must not create Docker containers");
  const nativeProcesses = ["runner-a", "runner-b"].reduce((sum, service) => sum + Number(compose(["exec", "-T", service, "node", "-e", "const fs=require('fs'); console.log(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[1]==='/app/runner.mjs'}catch{return false}}).length)"])), 0);
  assert.equal(nativeProcesses, 4);
  evidence.push({
    scenario: "two real Runners execute concurrently",
    tasks: 4,
    containers: listed,
    nativeProcesses,
    workers: [...new Set(assigned.map((r) => r.worker_id))],
  });
  const queued = await create(env.MEMBER_TOKEN);
  assert.equal((await state(queued)).state, "queued");
  // Kill one actual process: its active work is failed without automatic replay.
  compose(["kill", "-s", "SIGKILL", "runner-a"]);
  const killed = assigned.filter((r) => r.worker_id === "pig-cluster-runner-a");
  await until(
    async () =>
      (await Promise.all(killed.map((r) => state(r.id)))).every(
        (r) => r.state === "failed",
      ),
    "lease expiration after SIGKILL",
    35000,
  );
  evidence.push({
    scenario: "SIGKILL node",
    failedWithoutReplay: killed.map((r) => r.id),
  });
  // Cancel work on survivor, allowing the durable queued task to make progress.
  for (const r of assigned.filter(
    (r) => r.worker_id === "pig-cluster-runner-b",
  ))
    await req(`/v1/runs/${r.id}/abort`, {});
  await until(() => pending(queued), "queued task proceeds on survivor");
  assert.equal((await state(queued)).worker_id, "pig-cluster-runner-b");
  // Lose a control instance while this real Agent is awaiting approval.
  compose(["stop", "-t", "1", "cloud-a"]);
  const approval = await pending(queued);
  await req(`/v1/runs/${queued}/approvals/${approval.id}/decision`, {
    decision: "approve",
  });
  await until(async () => {
    const r = await state(queued);
    if (terminal(r)) {
      assert.equal(r.state, "succeeded", r.error);
      return r;
    }
  }, "surviving control completes task");
  const artifacts = await req(`/v1/runs/${queued}/artifacts`);
  assert.ok(artifacts.artifacts.some((a) => a.path === "cloud-proof.txt"));
  evidence.push({
    scenario: "surviving Runner and control instance",
    task: queued,
    state: "succeeded",
    artifact: "cloud-proof.txt",
  });
  compose(["start", "cloud-a", "runner-a"]);
  await until(async () => {
    const d = await req("/v1/admin/overview");
    return (
      d.workers.filter(
        (w) => w.id.startsWith("pig-cluster-runner-") && w.online,
      ).length === 2
    );
  }, "both nodes recover");
  // Isolate graceful shutdown to runner-b using drain policy on runner-a.
  const patch = async (id, enabled) => {
    const r = await fetch(base + "/v1/admin/workers/" + id, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled }),
    });
    assert.ok(r.ok);
  };
  await patch("pig-cluster-runner-a", false);
  const graceful = await create(env.MEMBER2_TOKEN);
  await until(() => pending(graceful), "graceful shutdown task");
  compose(["stop", "runner-b"]);
  const done = await until(async () => {
    const r = await state(graceful);
    return terminal(r) && r;
  }, "graceful shutdown result");
  assert.equal(done.state, "failed");
  evidence.push({
    scenario: "SIGTERM drain bounded shutdown",
    task: graceful,
    state: done.state,
  });
  compose(["start", "runner-b"]);
  await patch("pig-cluster-runner-a", true);
  await until(() => {
    const ids = ["pig-cluster-runner-a", "pig-cluster-runner-b"].flatMap((w) =>
      docker(["ps", "-aq", "--filter", "label=pig-agent.worker=" + w])
        .split("\n")
        .filter(Boolean),
    );
    return ids.length === 0;
  }, "all test containers reclaimed");
  await until(
    () =>
      ["pig-cluster-runner-a", "pig-cluster-runner-b"].every(
        (worker) =>
          !docker([
            "network",
            "ls",
            "-q",
            "--filter",
            "label=pig-agent.worker=" + worker,
          ]),
      ),
    "all test networks reclaimed",
  );
  evidence.push({
    scenario: "resource cleanup",
    remainingExecutionContainers: 0,
    remainingExecutionNetworks: 0,
  });
  await mkdir("data/cluster-local/evidence", { recursive: true });
  await writeFile(
    "data/cluster-local/evidence/runners.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        environment:
          "local Docker Desktop; 2 control instances; 2 Runner nodes x 2 slots; mock model",
        evidence,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real 2x2 cluster, four native processes, queued progress, SIGKILL lease expiry, control failover, cancellation, bounded SIGTERM drain and container cleanup.",
  );
} finally {
  compose(["start", "cloud-a", "runner-a", "runner-b"]);
  for (const id of runs) {
    try {
      if (!terminal(await state(id))) await req(`/v1/runs/${id}/abort`, {});
    } catch {}
  }
  await policy(old);
  for (const id of ["pig-cluster-runner-a", "pig-cluster-runner-b"])
    await fetch(base + "/v1/admin/workers/" + id, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
}
