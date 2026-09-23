import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
// Fixed isolated local cluster: never target the normal :8890 platform or a production host.
const base = "http://127.0.0.1:8892";
await mkdir("data/ecosystem-review", { recursive: true });
const values = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const fixtureToken = "synthetic-local-fixture";
const accounts = await prepareAccounts();
async function prepareAccounts() {
  try {
    const saved = JSON.parse(
      await readFile("data/ecosystem-review/accounts.json", "utf8"),
    );
    for (const account of saved.accounts) {
      const login = await fetch(base + "/auth/web/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({
          username: account.username,
          password: account.password,
        }),
      });
      if (!login.ok) throw Error("Cannot sign in to existing fixture account");
      account.cookie = login.headers.get("set-cookie")?.split(";")[0];
    }
    await writeFile(
      "data/ecosystem-review/accounts.json",
      JSON.stringify(saved),
      { mode: 0o600 },
    );
    return saved.accounts;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = [];
  const { randomBytes } = await import("node:crypto");
  async function setup(path, body, admin = false) {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        ...(admin ? { Authorization: "Bearer " + values.ADMIN_TOKEN } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw Error("Fixture account setup failed: " + r.status);
    return {
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  for (const suffix of ["a", "b"]) {
    const username = "eco_" + suffix + "_" + randomBytes(4).toString("hex"),
      password = randomBytes(20).toString("hex");
    await setup("/auth/web/register", {
      username,
      password,
      name: "生态验收 " + suffix.toUpperCase(),
      reason: "Isolated localhost acceptance fixture",
    });
    const list = (
      await setup("/v1/admin/registration-requests", undefined, true)
    ).data;
    const reg = list.requests.find((r) => r.username === username);
    await setup(
      "/v1/admin/registration-requests/" + reg.id + "/decision",
      { decision: "approve", reason: "Isolated acceptance fixture" },
      true,
    );
    const login = await setup("/auth/web/login", { username, password });
    result.push({ username, password, cookie: login.cookie });
  }
  await writeFile(
    "data/ecosystem-review/accounts.json",
    JSON.stringify({ base, accounts: result }),
    { mode: 0o600 },
  );
  return result;
}
const evidence = [];
let serverId;
async function req(
  path,
  { method = "GET", body, who = "admin", origin = base } = {},
) {
  const auth =
    who === "admin"
      ? { Authorization: `Bearer ${values.ADMIN_TOKEN}` }
      : who === "none"
        ? {}
        : { Cookie: accounts[who === "a" ? 0 : 1].cookie };
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: "non-json response" };
  }
  return { status: response.status, data };
}
function record(name, condition, details = {}) {
  evidence.push({ name, passed: Boolean(condition), ...details });
  if (!condition) throw Error(name);
  console.log("PASS " + name);
}
async function state() {
  return (await fetch("http://127.0.0.1:9910/state")).json();
}
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(300);
  }
  throw Error("Timed out: " + label);
}
async function run(tool, who = "admin", extra = {}) {
  const response = await req("/v1/runs", {
    method: "POST",
    who,
    body: {
      prompt: `[MCP_ACCEPTANCE:${tool}] acceptance fixture only`,
      requireApproval: false,
      networkPolicy: "ask",
      debugContent: true,
      ...extra,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.id;
}
async function approval(id) {
  return until(async () => {
    const r = await req(`/v1/runs/${id}/approvals`);
    return r.data.approvals?.find((a) => a.state === "pending");
  }, "approval " + id);
}
async function decide(id, a, decision) {
  return req(`/v1/runs/${id}/approvals/${a.id}/decision`, {
    method: "POST",
    body: { decision },
  });
}
async function terminal(id) {
  return until(
    async () => {
      const r = await req(`/v1/runs/${id}`);
      return ["succeeded", "failed", "cancelled"].includes(r.data.state)
        ? r.data
        : null;
    },
    "terminal " + id,
    40000,
  );
}
try {
  const channels = await req("/v1/admin/channels");
  assert.equal(channels.status, 200);
  assert.ok(
    !channels.data.channels.some((channel) => channel.enabled),
    "Refusing to run while a real model channel is active",
  );
  record(
    "authentication required",
    (await req("/v1/plugins", { who: "none" })).status === 401,
  );
  const catalog = await req("/v1/plugins/catalog", { who: "a" });
  record(
    "five useful built-in packs",
    catalog.status === 200 && catalog.data.catalog.length === 5,
  );
  await req("/v1/plugins/coding-quality", {
    who: "a",
    method: "PATCH",
    body: { enabled: false },
  });
  await req("/v1/plugins/coding-quality", { who: "a", method: "DELETE" });
  const installs = await Promise.all([
    req("/v1/plugins/catalog/coding-quality", { who: "a", method: "POST" }),
    req("/v1/plugins/catalog/coding-quality", { who: "a", method: "POST" }),
  ]);
  record(
    "competing installs preserve one copy",
    installs
      .map((r) => r.status)
      .sort()
      .join(",") === "201,409",
  );
  record(
    "plugins are private to account",
    (await req("/v1/plugins", { who: "b" })).data.plugins.length === 0,
  );
  record(
    "foreign enable rejected",
    (
      await req("/v1/plugins/coding-quality", {
        who: "b",
        method: "PATCH",
        body: { enabled: true },
      })
    ).status === 404,
  );
  record(
    "installed pack defaults disabled",
    (await req("/v1/plugins", { who: "a" })).data.plugins[0].enabled === false,
  );
  await req("/v1/plugins/coding-quality", {
    who: "a",
    method: "PATCH",
    body: { enabled: true },
  });
  const experts = await req("/v1/experts", { who: "a" }),
    skills = await req("/v1/skills", { who: "a" });
  record(
    "enabled expert references actual namespaced skill",
    experts.data.experts.some(
      (e) =>
        e.id === "plugin_coding-quality_quality-reviewer" &&
        e.skillIds.includes("plugin_coding-quality_review-checklist"),
    ) &&
      skills.data.skills.some(
        (s) =>
          s.id === "plugin_coding-quality_review-checklist" &&
          s.body.includes("验证"),
      ),
  );
  const contextRun = await run("echo", "a", {
    expertId: "plugin_coding-quality_quality-reviewer",
  });
  const contextResult = await terminal(contextRun);
  assert.match(contextRun, /^run_[a-f0-9]+$/);
  const contextStored =
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
        "-Atc",
        `SELECT coalesce(input->>'capabilityContext','') like '%代码审查%' FROM runs WHERE id='${contextRun}'`,
      ],
      { encoding: "utf8" },
    ).trim() === "t";
  record(
    "plugin expert accepted by actual Runner",
    contextResult.state === "succeeded" && contextStored,
    {
      runId: contextRun,
    },
  );
  record(
    "member cannot connect private MCP",
    (
      await req("/v1/mcp/servers", {
        who: "b",
        method: "POST",
        body: { name: "private-rejection", url: "http://127.0.0.1:9910/mcp" },
      })
    ).status === 400,
  );
  const created = await req("/v1/mcp/servers", {
    method: "POST",
    body: {
      name: "Independent MCP acceptance",
      url: "http://mcp-fixture:9910/mcp",
      secret: fixtureToken,
      timeoutMs: 4000,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  serverId = created.data.servers.at(-1).id;
  record(
    "saved credential is not returned",
    !JSON.stringify(created.data).includes(fixtureToken) &&
      created.data.servers.at(-1).secretConfigured,
  );
  record(
    "other account cannot see MCP",
    (await req("/v1/mcp/servers", { who: "b" })).data.servers.every(
      (s) => s.id !== serverId,
    ),
  );
  record(
    "other account cannot test MCP",
    (
      await req(`/v1/mcp/servers/${serverId}/test`, {
        who: "b",
        method: "POST",
        body: {},
      })
    ).status === 404,
  );
  const test = await req(`/v1/mcp/servers/${serverId}/test`, {
    method: "POST",
    body: {},
  });
  record(
    "real MCP handshake and discovery",
    test.status === 200 &&
      test.data.tools.length === 3 &&
      test.data.tools
        .find((t) => t.name === "echo")
        .inputSchema.required.includes("text"),
  );
  record(
    "shared config visible through second control instance",
    (
      await req("/v1/mcp/servers", { origin: "http://127.0.0.1:8894" })
    ).data.servers.some((s) => s.id === serverId),
  );
  await req(`/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: { enabled: true },
  });
  const baseline = await state();
  const approvedRun = await run("write_marker");
  const pending = await approval(approvedRun);
  record(
    "auto mode MCP still waits for one approval",
    pending.tool.includes("write_marker") &&
      (await state()).mutations === baseline.mutations,
    { runId: approvedRun },
  );
  record(
    "approval shows pinned external target",
    pending.mcp_target?.url === "http://mcp-fixture:9910/mcp" &&
      pending.mcp_target?.serverId === serverId,
  );
  record(
    "first approval succeeds",
    (await decide(approvedRun, pending, "approve")).status === 200,
  );
  record(
    "duplicate approval rejected",
    (await decide(approvedRun, pending, "approve")).status === 409,
  );
  const approved = await terminal(approvedRun);
  const after = await state();
  const events = await req(`/v1/runs/${approvedRun}/eventlog`);
  record(
    "real Runner invokes exactly once after approval",
    approved.state === "succeeded" &&
      after.mutations === baseline.mutations + 1 &&
      JSON.stringify(events.data).includes("independent-mcp-fixture"),
    { runId: approvedRun, workerId: approved.worker_id },
  );
  const rejectedRun = await run("write_marker"),
    rejectedApproval = await approval(rejectedRun);
  await decide(rejectedRun, rejectedApproval, "reject");
  await terminal(rejectedRun);
  record(
    "rejected approval produces no external side effect",
    (await state()).mutations === after.mutations,
    { runId: rejectedRun },
  );
  const cancelledRun = await run("write_marker");
  await approval(cancelledRun);
  await req(`/v1/runs/${cancelledRun}/abort`, { method: "POST", body: {} });
  const cancelled = await terminal(cancelledRun);
  record(
    "cancel while waiting never invokes",
    cancelled.state === "cancelled" &&
      (await state()).mutations === after.mutations,
    { runId: cancelledRun },
  );
  const changedRun = await run("write_marker"),
    oldApproval = await approval(changedRun);
  await req(`/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: { timeoutMs: 5000 },
  });
  await decide(changedRun, oldApproval, "approve");
  await terminal(changedRun);
  const changedEvents = await req(`/v1/runs/${changedRun}/eventlog`);
  record(
    "configuration edit invalidates old approval",
    (await state()).mutations === after.mutations &&
      JSON.stringify(changedEvents.data).includes("配置已变化"),
    { runId: changedRun },
  );
  await req(`/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: { timeoutMs: 20000 },
  });
  const beforeSlow = await state(),
    slowRun = await run("slow"),
    slowApproval = await approval(slowRun);
  await decide(slowRun, slowApproval, "approve");
  await until(async () => {
    const s = await state();
    return s.calls.length > beforeSlow.calls.length;
  }, "slow call started");
  await req(`/v1/runs/${slowRun}/abort`, { method: "POST", body: {} });
  await terminal(slowRun);
  await until(
    async () => {
      const s = await state();
      return s.cancelled > beforeSlow.cancelled;
    },
    "external cancellation",
    5000,
  );
  record("cancel reaches in-flight external request", true, { runId: slowRun });
  await req(`/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: { timeoutMs: 500 },
  });
  const timeoutRun = await run("slow"),
    timeoutApproval = await approval(timeoutRun);
  await decide(timeoutRun, timeoutApproval, "approve");
  await terminal(timeoutRun);
  record(
    "slow external call has a bounded timeout",
    JSON.stringify(
      (await req(`/v1/runs/${timeoutRun}/eventlog`)).data,
    ).includes("Connection closed"),
    { runId: timeoutRun },
  );
  const debug = await req(`/v1/runs/${approvedRun}/debug`);
  record(
    "credential absent from run events and debugger",
    events.status === 200 &&
      debug.status === 200 &&
      !JSON.stringify(events.data).includes(fixtureToken) &&
      !JSON.stringify(debug.data).includes(fixtureToken),
  );
} finally {
  if (serverId)
    await req(`/v1/mcp/servers/${serverId}`, {
      method: "PATCH",
      body: { enabled: false },
    }).catch(() => {});
  await writeFile(
    "data/ecosystem-review/cloud-acceptance.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: "isolated two-control two-runner cluster :8892",
        serverId,
        checks: evidence,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      checks: evidence.length,
      passed: evidence.filter((e) => e.passed).length,
      evidence: "data/ecosystem-review/cloud-acceptance.json",
    }),
  );
}
