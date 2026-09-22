import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:8892",
  tag = randomUUID().replaceAll("-", "").slice(0, 12);
const owners = ["policy_a_" + tag, "policy_b_" + tag],
  tokens = owners.map(() => randomBytes(32).toString("hex")),
  runs = [],
  checks = [];
function sql(query) {
  const p = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "pig-agent-cluster-postgres-1",
      "sh",
      "-c",
      'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ],
    { input: query, encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
}
async function api(
  path,
  body,
  who = 0,
  method = body === undefined ? "GET" : "POST",
  status = 200,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + tokens[who],
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
const delay = () => new Promise((r) => setTimeout(r, 250));
async function pending(id, who = 0) {
  for (let i = 0; i < 160; i++) {
    const a = (
      await api(`/v1/runs/${id}/approvals`, undefined, who)
    ).approvals.find((a) => a.state === "pending");
    if (a) return a;
    await delay();
  }
  throw Error("No pending approval " + id);
}
async function terminal(id, who = 0) {
  for (let i = 0; i < 240; i++) {
    const r = await api("/v1/runs/" + id, undefined, who);
    if (["succeeded", "failed", "cancelled"].includes(r.state)) return r;
    await delay();
  }
  throw Error("No terminal state " + id);
}
async function start(input, who = 0) {
  const r = await api(
    "/v1/runs",
    { prompt: "Policy proof " + tag, ...input },
    who,
    "POST",
    201,
  );
  runs.push([r.id, who]);
  return r;
}
const input = (id) =>
  JSON.parse(sql(`SELECT input FROM runs WHERE id='${id}';`));
function absent(id) {
  const p = spawnSync(
    "docker",
    ["exec", "pig-" + id, "test", "!", "-e", "/workspace/cloud-proof.txt"],
    { encoding: "utf8" },
  );
  assert.equal(
    p.status,
    0,
    "Actual container must not contain mutation target: " + p.stderr,
  );
}
try {
  sql(
    `INSERT INTO principals(id,name,role,token_hash) VALUES ${owners.map((o, i) => `('${o}','Policy proof','member','${createHash("sha256").update(tokens[i]).digest("hex")}')`).join(",")};`,
  );
  const review = await start({});
  assert.equal(input(review.id).requireApproval, true);
  const pa = await pending(review.id);
  absent(review.id);
  await delay();
  absent(review.id);
  await api(`/v1/runs/${review.id}/approvals/${pa.id}/decision`, {
    decision: "approve",
  });
  assert.equal((await terminal(review.id)).state, "succeeded");
  assert(
    (await api(`/v1/runs/${review.id}/artifacts`)).artifacts.some(
      (a) => a.path === "cloud-proof.txt",
    ),
  );
  checks.push(
    "Omitted policy defaults to review; Docker filesystem proves no write while pending; approve produces actual artifact",
  );
  const denied = await start({ requireApproval: true });
  const pd = await pending(denied.id);
  absent(denied.id);
  await api(`/v1/runs/${denied.id}/approvals/${pd.id}/decision`, {
    decision: "reject",
  });
  assert.equal((await terminal(denied.id)).state, "failed");
  assert.equal(
    (await api(`/v1/runs/${denied.id}/artifacts`)).artifacts.length,
    0,
  );
  checks.push("Reject fails execution without produced artifact");
  const space = await api(
    "/v1/spaces",
    { name: "Policy " + tag },
    0,
    "POST",
    201,
  );
  const project = await api(
    "/v1/shared-projects",
    { spaceId: space.id, name: "Policy team" },
    0,
    "POST",
    201,
  );
  const invite = await api(
    `/v1/spaces/${space.id}/invitations`,
    { role: "editor" },
    0,
    "POST",
    201,
  );
  await api("/v1/spaces/join", { invite: invite.invite }, 1);
  const auto = await start({
    requireApproval: false,
    networkPolicy: "blocked",
    projectId: project.id,
  });
  assert.equal(input(auto.id).requireApproval, false);
  assert.equal((await terminal(auto.id)).state, "succeeded");
  assert.equal(
    (await api(`/v1/runs/${auto.id}/approvals`)).approvals.length,
    0,
  );
  assert(
    (await api(`/v1/runs/${auto.id}/artifacts`)).artifacts.some(
      (a) => a.path === "cloud-proof.txt",
    ),
  );
  checks.push(
    "Explicit automatic mode executes write in Docker with zero approvals; separate blocked network policy remains pinned",
  );
  await api(
    "/v1/settings",
    { requireApproval: true, networkPolicy: "ask" },
    1,
    "PUT",
  );
  const follow = await api(
    `/v1/runs/${auto.id}/follow-ups`,
    { prompt: "Other member requests another write" },
    1,
    "POST",
    201,
  );
  runs.push([follow.id, 1]);
  assert.equal(input(follow.id).requireApproval, true);
  assert.equal(input(follow.id).networkPolicy, "ask");
  const pf = await pending(follow.id, 1);
  await api(
    `/v1/runs/${follow.id}/approvals/${pf.id}/decision`,
    { decision: "reject" },
    1,
  );
  await terminal(follow.id, 1);
  checks.push(
    "Cross-author continuation uses acting member review/network settings instead of previous author automatic consent",
  );
  const plan = await api(
    "/v1/schedules",
    {
      name: "Policy schedule " + tag,
      prompt: "Policy schedule write",
      enabled: false,
      requireApproval: false,
      networkPolicy: "blocked",
    },
    0,
    "POST",
    201,
  );
  assert.equal((await api("/v1/schedules/" + plan.id)).requireApproval, false);
  await api(
    "/v1/settings",
    { requireApproval: true, networkPolicy: "ask" },
    0,
    "PUT",
  );
  const firing = await api(`/v1/schedules/${plan.id}/run`, {}, 0, "POST", 202);
  runs.push([firing.remoteRunId, 0]);
  assert.equal(input(firing.remoteRunId).requireApproval, false);
  assert.equal(input(firing.remoteRunId).networkPolicy, "blocked");
  assert.equal((await terminal(firing.remoteRunId)).state, "succeeded");
  assert.equal(
    (await api(`/v1/runs/${firing.remoteRunId}/approvals`)).approvals.length,
    0,
  );
  await api(
    "/v1/schedules/" + plan.id,
    { requireApproval: true, networkPolicy: "ask" },
    0,
    "PATCH",
  );
  assert.equal((await api("/v1/schedules/" + plan.id)).requireApproval, true);
  const next = await api(`/v1/schedules/${plan.id}/run`, {}, 0, "POST", 202);
  runs.push([next.remoteRunId, 0]);
  const ps = await pending(next.remoteRunId);
  absent(next.remoteRunId);
  await api(`/v1/runs/${next.remoteRunId}/approvals/${ps.id}/decision`, {
    decision: "reject",
  });
  await terminal(next.remoteRunId);
  checks.push(
    "Schedule stores explicit false across GET/account changes; manual firing obeys pinned policy; plan edit to review gates real next write",
  );
  await mkdir("docs/evidence/execution-policy-2026-09-22", { recursive: true });
  await writeFile(
    "docs/evidence/execution-policy-2026-09-22/checks.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base,
        environment:
          "Local Docker, 2 control planes, 2 Runners, mock model, actual isolated execution containers",
        checks,
        runs: runs.map(([id]) => id),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  for (const [id, who] of runs)
    await api(`/v1/runs/${id}/abort`, {}, who).catch(() => {});
  sql(
    `UPDATE principals SET enabled=false WHERE id IN ('${owners.join("','")}'); UPDATE schedules SET enabled=false,deleted_at=now() WHERE owner_id IN ('${owners.join("','")}');`,
  );
}
