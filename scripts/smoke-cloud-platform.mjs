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
    token = env.ADMIN_TOKEN,
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
const accounts = [];
let fixtureChannel;
try {
  await req("/v1/admin/accounts", { token: env.MEMBER_TOKEN, status: 403 });
  for (let i = 0; i < 10; i++) {
    const invite = await req("/v1/admin/invitations", {
      body: { name: "acceptance-" + randomUUID().slice(0, 8) },
      status: 201,
    });
    const accepted = await req("/auth/accept-invite", {
      body: { invite: invite.invite },
      token: "",
      status: 201,
    });
    accounts.push(accepted);
    await req("/auth/accept-invite", {
      body: { invite: invite.invite },
      token: "",
      status: 401,
    });
    assert.equal(
      (await req("/v1/me", { token: accepted.token })).id,
      accepted.account.id,
    );
  }
  const renewal = await req("/v1/admin/invitations", {
    body: { name: accounts[0].account.name, accountId: accounts[0].account.id },
    status: 201,
  });
  const device = await req("/auth/accept-invite", {
    body: { invite: renewal.invite },
    token: "",
    status: 201,
  });
  assert.equal(device.account.id, accounts[0].account.id);
  assert.notEqual(device.token, accounts[0].token);
  const created = await Promise.all(
    accounts.map((a) =>
      req("/v1/runs", {
        token: a.token,
        body: { prompt: "Ten account container acceptance" },
        status: 201,
      }),
    ),
  );
  await req("/v1/runs/" + created[0].id, {
    token: accounts[1].token,
    status: 404,
  });
  for (let i = 0; i < created.length; i++) {
    let r;
    for (let n = 0; n < 600; n++) {
      r = await req("/v1/runs/" + created[i].id, { token: accounts[i].token });
      if (["succeeded", "failed", "cancelled"].includes(r.state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(r.state, "succeeded", r.error);
    assert.ok(
      Number(
        (await req("/v1/usage", { token: accounts[i].token })).calls_today,
      ) > 0,
    );
  }
  const resourcePolicy = await req("/v1/admin/resources");
  let resourceRun;
  try {
    await req("/v1/admin/resources", {
      method: "PUT",
      body: { profile: "large" },
    });
    resourceRun = await req("/v1/runs", {
      token: accounts[0].token,
      body: { prompt: "Resource profile acceptance" },
      status: 201,
    });
  } finally {
    await req("/v1/admin/resources", {
      method: "PUT",
      body: { profile: resourcePolicy.selected },
    });
  }
  let attempts = [];
  for (let n = 0; n < 300; n++) {
    attempts = (
      await req(`/v1/runs/${resourceRun.id}/attempts`, {
        token: accounts[0].token,
      })
    ).attempts;
    if (attempts[0]?.state === "succeeded") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(attempts[0]?.state, "succeeded");
  assert.equal(attempts[0]?.resources.memoryMiB, 1024);
  assert.equal(attempts[0]?.resources.cpu, 2);
  const first = accounts[0];
  await req("/v1/admin/accounts/" + first.account.id, {
    method: "PATCH",
    body: { dailyCallLimit: 0 },
  });
  const limited = await req("/v1/runs", {
    token: first.token,
    body: { prompt: "Budget rejection" },
    status: 201,
  });
  let limitedRun;
  for (let n = 0; n < 300; n++) {
    limitedRun = await req("/v1/runs/" + limited.id, { token: first.token });
    if (["failed", "succeeded"].includes(limitedRun.state)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(limitedRun.state, "failed");
  const channel = (fixtureChannel = await req("/v1/admin/channels", {
    body: {
      name: "Disabled test fixture",
      baseUrl: "https://example.invalid/v1",
      model: "fixture",
      apiKey: "fixture-not-a-real-key",
    },
    status: 201,
  }));
  const list = await req("/v1/admin/channels");
  assert.ok(list.channels.some((c) => c.id === channel.id && !c.enabled));
  assert.ok(!JSON.stringify(list).includes("fixture-not-a-real-key"));
  await req("/v1/logout", { token: first.token, method: "POST" });
  await req("/v1/me", { token: first.token, status: 401 });
  console.log(
    "PASS: 10 invited accounts, one-time redemption, isolated container runs, daily quota enforcement, redacted encrypted channel, revocable sessions.",
  );
} finally {
  if (fixtureChannel)
    await req(`/v1/admin/channels/${fixtureChannel.id}`, { method: "DELETE" });
  for (const a of accounts)
    await req("/v1/admin/accounts/" + a.account.id, {
      method: "PATCH",
      body: { enabled: false, revokeSessions: true },
    });
}
