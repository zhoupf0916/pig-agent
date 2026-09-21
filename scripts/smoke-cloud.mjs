import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const base = "http://127.0.0.1:8890",
  member = env.MEMBER_TOKEN,
  other = env.MEMBER2_TOKEN,
  admin = env.ADMIN_TOKEN;
async function request(
  path,
  { token = member, method = "GET", body, key, status = 200 } = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${r.status} ${await (r.status !== status ? r.clone().text() : Promise.resolve(""))}`,
  );
  return r;
}
async function create(prompt = "本地云平台验收：创建并读回一个文件", key) {
  return (
    await request("/v1/runs", {
      method: "POST",
      body: { prompt },
      key,
      status: 201,
    })
  ).json();
}
async function wait(
  id,
  states = ["succeeded", "failed", "cancelled"],
  timeout = 90000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await (await request("/v1/runs/" + id)).json();
    if (states.includes(r.state)) return r;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for " + id);
}
await request("/v1/runs", { token: "invalid", status: 401 });
await request("/v1/admin/overview", { status: 403 });
await request("/internal/claim", {
  method: "POST",
  body: { workerId: "untrusted" },
  status: 401,
});
await request("/v1/runs", {
  method: "POST",
  body: { prompt: "bad", files: [{ path: "../escape", content: "x" }] },
  status: 400,
});
const key = randomUUID(),
  first = await create(undefined, key);
const same = await (
  await request("/v1/runs", {
    method: "POST",
    body: { prompt: "本地云平台验收：创建并读回一个文件" },
    key,
  })
).json();
assert.equal(same.id, first.id);
await request("/v1/runs", {
  method: "POST",
  body: { prompt: "changed" },
  key,
  status: 409,
});
await request("/v1/runs/" + first.id, { token: other, status: 404 });
await request(`/v1/runs/${first.id}/abort`, {
  token: other,
  method: "POST",
  status: 404,
});
await request(`/v1/runs/${first.id}/events`, { token: other, status: 404 });
const done = await wait(first.id);
assert.equal(done.state, "succeeded", done.error);
const files = await (await request(`/v1/runs/${first.id}/artifacts`)).json();
const proof = files.artifacts.find((f) => f.path === "cloud-proof.txt");
assert.ok(proof, "proof artifact exists");
assert.equal(
  await (await request(`/v1/runs/${first.id}/artifacts/${proof.id}`)).text(),
  "PIG_CLOUD_CONTAINER_OK\n",
);
await request(`/v1/runs/${first.id}/artifacts/${proof.id}`, {
  token: other,
  status: 404,
});
const events = await (await request(`/v1/runs/${first.id}/events`)).text();
const ids = [...events.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
assert.ok(ids.length >= 5);
assert.equal(new Set(ids).size, ids.length);
assert.match(events, /write_file/);
assert.match(events, /read_file/);
const replay = await (
  await request(`/v1/runs/${first.id}/events?after=${ids[0]}`)
).text();
assert.deepEqual(
  [...replay.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1])),
  ids.slice(1),
);
const parallel = await Promise.all([create(), create(), create()]);
assert.ok(
  (await Promise.all(parallel.map((r) => wait(r.id)))).every(
    (r) => r.state === "succeeded",
  ),
);
const cancel = await create();
await wait(cancel.id, ["running"]);
const inspection = JSON.parse(
  execFileSync("docker", ["inspect", "pig-" + cancel.id], { encoding: "utf8" }),
)[0];
assert.equal(inspection.Config.User, "1000:1000");
assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
assert.equal(inspection.HostConfig.Memory, 512 * 1024 * 1024);
assert.equal(inspection.Mounts.length, 0);
const network = JSON.parse(
  execFileSync(
    "docker",
    ["network", "inspect", Object.keys(inspection.NetworkSettings.Networks)[0]],
    { encoding: "utf8" },
  ),
)[0];
assert.equal(network.Internal, true);
assert.equal(Object.keys(network.Containers).length, 2);

await request(`/v1/runs/${cancel.id}/abort`, { token: admin, method: "POST" });
assert.equal((await wait(cancel.id)).state, "cancelled");
const crash = await create();
await wait(crash.id, ["running"]);
const compose = [
  "compose",
  "--env-file",
  "data/cloud-local/stack.env",
  "-f",
  "infra/cloud/compose.yml",
];
const workerContainer = execFileSync(
  "docker",
  [...compose, "ps", "-q", "worker"],
  { encoding: "utf8" },
).trim();
execFileSync("docker", ["kill", workerContainer], { stdio: "pipe" });
execFileSync("docker", [...compose, "start", "worker"], { stdio: "pipe" });
assert.equal((await wait(crash.id)).state, "failed");
const recovery = await create();
assert.equal((await wait(recovery.id)).state, "succeeded");
const overview = await (
  await request("/v1/admin/overview", { token: admin })
).json();
assert.ok(overview.workers.some((w) => w.online));
assert.ok(
  overview.audit.some((a) => a.action === "cancel" && a.actor === "admin"),
);
await new Promise((r) => setTimeout(r, 1000));
assert.equal(
  execFileSync(
    "docker",
    ["ps", "-aq", "--filter", "label=pig-agent.managed=true"],
    { encoding: "utf8" },
  ).trim(),
  "",
);
assert.equal(
  execFileSync(
    "docker",
    ["network", "ls", "-q", "--filter", "label=pig-agent.managed=true"],
    { encoding: "utf8" },
  ).trim(),
  "",
);
execFileSync("docker", [...compose, "restart", "-t", "1", "cloud"], {
  stdio: "pipe",
});
for (let retry = 0; retry < 30; retry++) {
  try {
    const r = await fetch(base + "/health");
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(
  await (await request(`/v1/runs/${first.id}/artifacts/${proof.id}`)).text(),
  "PIG_CLOUD_CONTAINER_OK\n",
);
console.log(
  "Cloud smoke passed: auth, owner isolation, input validation, idempotency, real container write/read/download, SSE replay, 3 tasks, admin cancellation, worker restart recovery, audit, container/network cleanup, sandbox policies and control-plane restart persistence.",
);
