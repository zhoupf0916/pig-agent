import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8892";
const env = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .split("\n")
    .filter((s) => s.includes("="))
    .map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
const adminId = "auth_review_" + randomUUID().replaceAll("-", "");
const adminToken = randomBytes(32).toString("hex");
const hashed = createHash("sha256").update(adminToken).digest("hex");
function psql(input) {
  return new Promise((resolve, reject) => {
    let out = "",
      err = "";
    const p = spawn(
      "docker",
      [
        "exec",
        "-i",
        "pig-agent-cluster-postgres-1",
        "sh",
        "-c",
        'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code ? reject(new Error(err)) : resolve(out)));
    p.stdin.end(input);
  });
}
async function api(path, token, method = "GET", body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
let run, controller, reader;
try {
  await psql(
    `INSERT INTO principals(id,name,role,token_hash) VALUES('${adminId}','Isolated auth review fixture','admin','${hashed}');`,
  );
  const response = await api("/v1/runs", env.MEMBER_TOKEN, "POST", {
    prompt: "Auth demotion regression: create a harmless proof file.",
    requireApproval: true,
  });
  assert.equal(response.status, 201);
  run = await response.json();
  for (let i = 0; i < 90; i++) {
    const approvals = await (
      await api("/v1/runs/" + run.id + "/approvals", env.MEMBER_TOKEN)
    ).json();
    if (approvals.approvals?.some((a) => a.state === "pending")) break;
    if (i === 89) throw Error("Fixture never reached approval");
    await new Promise((r) => setTimeout(r, 500));
  }
  controller = new AbortController();
  const stream = await fetch(base + "/v1/runs/" + run.id + "/events", {
    headers: { Authorization: "Bearer " + adminToken },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  reader = stream.body.getReader();
  const initial = await reader.read();
  assert(!initial.done);
  const began = Date.now();
  await psql(`UPDATE principals SET role='member' WHERE id='${adminId}';`);
  const timeout = setTimeout(() => controller.abort(), 5000);
  let ended = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        ended = true;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  assert(ended, "Existing admin SSE did not close after demotion");
  const denied = await api("/v1/runs/" + run.id, adminToken);
  assert.equal(denied.status, 404);
  const streamDenied = await api("/v1/runs/" + run.id + "/events", adminToken);
  assert.equal(streamDenied.status, 404);
  const result = {
    at: new Date().toISOString(),
    environment: "local 2-control-plane Docker cluster :8892",
    fixturePrincipal: adminId,
    runId: run.id,
    checks: [
      "Fixture admin could subscribe to member-owned private run",
      "Demotion closed already-open run SSE",
      "Demoted fixture cannot fetch private run or resubscribe",
    ],
    revocationObservedWithinMs: Date.now() - began,
    existingAdminUnmodified: true,
  };
  await mkdir("data/cloud-web-evidence", { recursive: true });
  await writeFile(
    "data/cloud-web-evidence/admin-demotion.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  controller?.abort();
  await reader?.cancel().catch(() => {});
  if (run?.id)
    await api(
      "/v1/runs/" + run.id + "/abort",
      env.MEMBER_TOKEN,
      "POST",
      {},
    ).catch(() => {});
  await psql(
    `DELETE FROM auth_sessions WHERE owner_id='${adminId}'; DELETE FROM principals WHERE id='${adminId}';`,
  );
}
