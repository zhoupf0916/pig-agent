import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(
  (await readFile("data/cloud-local/stack.env", "utf8"))
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = "http://127.0.0.1:8890",
  accounts = [];
async function req(
  path,
  {
    token = env.ADMIN_TOKEN,
    body,
    method = body ? "POST" : "GET",
    status = 200,
    key = randomUUID(),
    raw = false,
  } = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(
    r.status,
    status,
    await (r.status !== status ? r.clone().text() : Promise.resolve(path)),
  );
  return raw ? r : r.json();
}
async function wait(id, token) {
  for (let i = 0; i < 300; i++) {
    const r = await req("/v1/runs/" + id, { token });
    if (["succeeded", "failed", "cancelled"].includes(r.state)) {
      assert.equal(r.state, "succeeded", r.error);
      return r;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Run timeout");
}
try {
  for (let i = 0; i < 3; i++) {
    const invite = await req("/v1/admin/invitations", {
      body: { name: "collaboration-" + randomUUID().slice(0, 8) },
      status: 201,
    });
    accounts.push(
      await req("/auth/accept-invite", {
        body: { invite: invite.invite },
        status: 201,
      }),
    );
  }
  const [owner, viewer, editor] = accounts;
  const space = await req("/v1/spaces", {
    token: owner.token,
    body: { name: "Shared project acceptance" },
    status: 201,
  });
  const project = await req("/v1/shared-projects", {
    token: owner.token,
    body: { spaceId: space.id, name: "Acceptance" },
    status: 201,
  });
  for (const [account, role] of [
    [viewer, "viewer"],
    [editor, "editor"],
  ]) {
    const invitation = await req(`/v1/spaces/${space.id}/invitations`, {
      token: owner.token,
      body: { role },
      status: 201,
    });
    await req("/v1/spaces/join", {
      token: account.token,
      body: { invite: invitation.invite },
    });
    await req("/v1/spaces/join", {
      token: account.token,
      body: { invite: invitation.invite },
      status: 404,
    });
  }
  await req(`/v1/spaces/${space.id}/members/${owner.account.id}`, {
    token: owner.token,
    method: "DELETE",
    status: 409,
  });
  await req(`/v1/spaces/${space.id}/invitations`, {
    token: editor.token,
    body: { role: "admin" },
    status: 403,
  });
  await req("/v1/shared-projects", {
    token: viewer.token,
    body: { spaceId: space.id, name: "Denied" },
    status: 403,
  });
  await req("/v1/runs", {
    token: viewer.token,
    body: { projectId: project.id, prompt: "Denied" },
    status: 403,
  });
  const key = randomUUID(),
    run = await req("/v1/runs", {
      token: editor.token,
      body: { projectId: project.id, prompt: "Shared workspace acceptance" },
      status: 201,
      key,
    });
  const complete = await wait(run.id, owner.token);
  assert.equal(
    (await req(`/v1/runs/${run.id}`, { token: viewer.token })).can_write,
    false,
  );
  await req(`/v1/runs/${run.id}/abort`, {
    token: viewer.token,
    method: "POST",
    status: 404,
  });
  await req(`/v1/runs/${run.id}`, { token: env.MEMBER2_TOKEN, status: 404 });
  assert.equal(
    (
      await req(`/v1/conversations/${complete.conversation_id}`, {
        token: viewer.token,
      })
    ).runs.length,
    1,
  );
  const files = await req(`/v1/runs/${run.id}/artifacts`, {
    token: viewer.token,
  });
  assert.ok(files.artifacts.length);
  const follow = await req(`/v1/runs/${run.id}/follow-ups`, {
    token: owner.token,
    body: { prompt: "Continue across members" },
    status: 201,
  });
  await wait(follow.id, viewer.token);
  const privateRun = await req("/v1/runs", {
    token: viewer.token,
    body: { prompt: "Private must remain private" },
    status: 201,
  });
  await req(`/v1/runs/${privateRun.id}`, { token: owner.token, status: 404 });
  await wait(privateRun.id, viewer.token);
  await req(`/v1/spaces/${space.id}/members/${editor.account.id}`, {
    token: owner.token,
    method: "DELETE",
  });
  for (const path of [
    `/v1/runs/${run.id}`,
    `/v1/runs/${run.id}/eventlog`,
    `/v1/runs/${run.id}/attempts`,
    `/v1/runs/${run.id}/artifacts`,
    `/v1/conversations/${complete.conversation_id}`,
    `/v1/conversations/${complete.conversation_id}/workspace/${run.id}`,
  ])
    await req(path, { token: editor.token, status: 404 });
  await req("/v1/runs", {
    token: editor.token,
    body: { projectId: project.id, prompt: "Shared workspace acceptance" },
    key,
    status: 403,
  });
  await req(`/v1/runs/${follow.id}/follow-ups`, {
    token: editor.token,
    body: { prompt: "Removed member denied" },
    status: 404,
  });
  assert.equal(
    (await req("/v1/runs", { token: editor.token })).runs.length,
    0,
    "Ownership must not bypass revoked project membership",
  );
  await req(`/v1/spaces/${space.id}/members/${viewer.account.id}`, {
    token: owner.token,
    method: "PATCH",
    body: { role: "editor" },
  });
  const allowed = await req(`/v1/runs/${follow.id}/follow-ups`, {
    token: viewer.token,
    body: { prompt: "Promoted editor continues" },
    status: 201,
  });
  await wait(allowed.id, owner.token);
  console.log(
    "PASS: organization invitations/roles, shared project execution, cross-member follow-up, private isolation, read-only enforcement, creator revocation across artifacts/transcripts/attempts, promotion and stale idempotency authorization.",
  );
} finally {
  for (const a of accounts)
    await req(`/v1/admin/accounts/${a.account.id}`, {
      method: "PATCH",
      body: { enabled: false, revokeSessions: true },
    });
}
