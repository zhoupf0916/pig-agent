import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = "http://127.0.0.1:8890";
async function req(
  path,
  {
    token = env.MEMBER_TOKEN,
    body,
    method = body ? "POST" : "GET",
    status = 200,
  } = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    r.status,
    status,
    await (r.status !== status ? r.clone().text() : Promise.resolve(path)),
  );
  return r.json();
}
async function approval(id) {
  for (let n = 0; n < 200; n++) {
    const list = await req(`/v1/runs/${id}/approvals`);
    const pending = list.approvals.find((a) => a.state === "pending");
    if (pending) return pending;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("Approval timeout");
}
async function terminal(id) {
  for (let n = 0; n < 300; n++) {
    const r = await req("/v1/runs/" + id);
    if (["succeeded", "failed", "cancelled"].includes(r.state)) return r;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("Run timeout");
}
const run = await req("/v1/runs", {
  body: { prompt: "Approval success acceptance", requireApproval: true },
  status: 201,
});
const pending = await approval(run.id);
assert.equal(pending.tool, "write_file");
await req(`/v1/runs/${run.id}/approvals/${pending.id}/decision`, {
  token: env.MEMBER2_TOKEN,
  body: { decision: "approve" },
  status: 403,
});
// Simulate a returning client: no subscription is necessary; the DB keeps the request.
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await approval(run.id)).id, pending.id);
const log = await req(`/v1/runs/${run.id}/eventlog`);
assert.ok(
  !log.events.some(
    (e) => e.event.type === "tool_end" && e.event.name === "write_file",
  ),
  "Mutation must not execute before approval",
);
await req(`/v1/runs/${run.id}/approvals/${pending.id}/decision`, {
  body: { decision: "approve" },
});
await req(`/v1/runs/${run.id}/approvals/${pending.id}/decision`, {
  body: { decision: "approve" },
  status: 409,
});
assert.equal((await terminal(run.id)).state, "succeeded");
assert.equal(
  (await req(`/v1/runs/${run.id}/approvals`)).approvals[0].state,
  "consumed",
);
assert.ok(
  (await req(`/v1/runs/${run.id}/artifacts`)).artifacts.some(
    (a) => a.path === "cloud-proof.txt",
  ),
);
const rejected = await req("/v1/runs", {
  body: { prompt: "Approval rejection acceptance", requireApproval: true },
  status: 201,
});
const rejectRequest = await approval(rejected.id);
await req(`/v1/runs/${rejected.id}/approvals/${rejectRequest.id}/decision`, {
  body: { decision: "reject" },
});
assert.equal((await terminal(rejected.id)).state, "failed");
assert.equal(
  (await req(`/v1/runs/${rejected.id}/artifacts`)).artifacts.length,
  0,
);
const cancelled = await req("/v1/runs", {
  body: { prompt: "Approval cancellation acceptance", requireApproval: true },
  status: 201,
});
const stale = await approval(cancelled.id);
await req(`/v1/runs/${cancelled.id}/abort`, { method: "POST" });
assert.equal((await terminal(cancelled.id)).state, "cancelled");
await req(`/v1/runs/${cancelled.id}/approvals/${stale.id}/decision`, {
  body: { decision: "approve" },
  status: 409,
});
assert.equal(
  (await req(`/v1/runs/${cancelled.id}/approvals`)).approvals[0].state,
  "expired",
);
console.log(
  "PASS: persisted approval after client disconnect, no pre-approval mutation, owner-only decisions, one-time authorization, explicit rejection, cancellation and expired approval protection.",
);
