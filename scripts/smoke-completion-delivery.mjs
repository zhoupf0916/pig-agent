import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
const env = parseEnv(await readFile("data/cluster-local/stack.env", "utf8"));
const base = "http://127.0.0.1:8892";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body, method, token = env.ADMIN_TOKEN) {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error(`${path}: ${r.status}`);
  return r.json();
}
assert.equal((await api("/health")).modelMode, "mock");
const overview = await api("/v1/admin/overview");
assert(overview.workers.every((w) => w.active === 0));
assert(
  !overview.counts.some(
    (c) =>
      ["queued", "running", "preparing", "cancelling"].includes(c.state) &&
      c.count > 0,
  ),
);
await mkdir("data/acceptance-redesign", { recursive: true });
const finishes = [];
let fault = false,
  child;
const proxy = createServer(async (req, res) => {
  try {
    let chunks = [];
    for await (const b of req) chunks.push(b);
    const body = Buffer.concat(chunks);
    if (req.url.endsWith("/finish")) {
      const p = JSON.parse(body);
      finishes.push({
        ok: p.ok,
        files: p.files?.map((f) => f.path),
        error: p.error,
        injected: fault,
      });
      if (fault === "before") {
        fault = false;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"review injected transient failure"}');
        return;
      }
    }
    const upstream = await fetch(base + req.url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${env.WORKER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body.length ? body : undefined,
    });
    const text = await upstream.text();
    if (req.url.endsWith("/finish") && fault === "after") {
      fault = false;
      res.destroy();
      return;
    }
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(text);
  } catch (e) {
    res.writeHead(502);
    res.end("{}");
  }
});
await new Promise((r) => proxy.listen(18895, "127.0.0.1", r));
const sock = execFileSync(
  "docker",
  ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  { encoding: "utf8" },
)
  .trim()
  .replace("unix://", "");
await writeFile(
  "data/acceptance-redesign/docker-shim.mjs",
  `import http from 'node:http';const socket=${JSON.stringify(sock)};for(const name of ['request','get']){const original=http[name];http[name]=function(options,...rest){if(options?.socketPath==='/var/run/docker.sock')options={...options,socketPath:socket};return original.call(this,options,...rest)}}`,
);
const workerId = "redesign-finish-fault";
const results = [];
try {
  for (const w of overview.workers)
    if (w.enabled)
      await api(
        "/v1/admin/workers/" + encodeURIComponent(w.id),
        { enabled: false },
        "PATCH",
      );
  const workerEnv = {
    ...process.env,
    CONTROL_URL: "http://127.0.0.1:18895",
    WORKER_TOKEN: env.WORKER_TOKEN,
    WORKER_ID: workerId,
    WORKER_OUTBOX_DIR: "data/acceptance-redesign/outbox",
    WORKER_CAPACITY: "1",
    WORKER_NAMESPACE: "pig-agent-review",
    GATEWAY_CONTAINER: "pig-agent-cluster-gateway-1",
    RUNNER_IMAGE: "pig-agent-cluster-runner:local",
  };
  child = spawn(
    process.execPath,
    [
      "--import",
      "./data/acceptance-redesign/docker-shim.mjs",
      "--import",
      "tsx",
      "apps/worker/src/index.ts",
    ],
    { env: workerEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => process.stdout.write(b));
  child.stderr.on("data", (b) => process.stderr.write(b));
  for (let i = 0; i < 50; i++) {
    try {
      await api("/v1/admin/workers/" + workerId, { enabled: true }, "PATCH");
      break;
    } catch {
      await wait(100);
    }
  }
  for (const inject of [false, "before", "after"]) {
    fault = inject;
    const run = await api(
      "/v1/runs",
      { prompt: "Acceptance review: mock container writes cloud-proof.txt" },
      undefined,
      env.MEMBER_TOKEN,
    );
    let state;
    for (let i = 0; i < 100; i++) {
      state = await api("/v1/runs/" + run.id);
      if (["succeeded", "failed", "cancelled"].includes(state.state)) break;
      await wait(300);
    }
    for (let i = 0; i < 100; i++) {
      const pending = await readFile(
        `data/acceptance-redesign/outbox/${run.id}.json`,
      ).catch(() => null);
      if (!pending) break;
      await wait(100);
    }
    assert.equal(
      await readFile(`data/acceptance-redesign/outbox/${run.id}.json`).catch(
        () => null,
      ),
      null,
      "completion must be acknowledged before next scenario",
    );
    const artifacts = await api("/v1/runs/" + run.id + "/artifacts");
    assert.equal(state.state, "succeeded");
    assert(artifacts.artifacts.some((a) => a.path === "cloud-proof.txt"));
    assert.equal(artifacts.artifacts.length, 1);
    const download = await fetch(
      base + "/v1/runs/" + run.id + "/artifacts/" + artifacts.artifacts[0].id,
      { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } },
    );
    assert.equal(download.status, 200);
    assert.equal((await download.text()).trim(), "PIG_CLOUD_CONTAINER_OK");
    results.push({
      inject,
      id: run.id,
      state: state.state,
      error: state.error,
      artifacts: artifacts.artifacts.map((a) => a.path),
    });
  }
  console.log(JSON.stringify({ results, finishes }, null, 2));
  await writeFile(
    "data/acceptance-redesign/finish-fault.json",
    JSON.stringify({ results, finishes }, null, 2),
  );
} finally {
  if (child) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, wait(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await api("/v1/admin/workers/" + workerId, { enabled: false }, "PATCH").catch(
    () => {},
  );
  for (const w of overview.workers)
    if (w.enabled)
      await api(
        "/v1/admin/workers/" + encodeURIComponent(w.id),
        { enabled: true },
        "PATCH",
      );
  proxy.close();
}
