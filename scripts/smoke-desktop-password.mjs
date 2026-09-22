import { createServer } from "node:http";
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = process.cwd(),
  base = "http://127.0.0.1:8892",
  profile = await mkdtemp(join(tmpdir(), "pig-password-desktop-")),
  username = "desk_" + randomUUID().replaceAll("-", "").slice(0, 12),
  password = randomBytes(20).toString("base64url");
const env = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .split("\n")
    .filter((s) => s.includes("="))
    .map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + env.ADMIN_TOKEN,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
const executablePath = createRequire(root + "/apps/desktop/package.json")(
  "electron",
);
let desktop, ownerId, authFixture;
const checks = [];
try {
  await api("/auth/web/register", {
    username,
    password,
    name: "Desktop password test",
  });
  const pending = (await api("/v1/admin/registration-requests")).requests.find(
    (r) => r.username === username,
  );
  ownerId = (
    await api(`/v1/admin/registration-requests/${pending.id}/decision`, {
      decision: "approve",
    })
  ).ownerId;
  async function launch() {
    desktop = await electron.launch({
      executablePath,
      args: [root + "/apps/desktop"],
      env: { ...process.env, PIG_DESKTOP_USER_DATA: profile },
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    await page.waitForURL("pig://app/");
    return page;
  }
  let page = await launch();
  const login = await page.evaluate(
    async ({ username, password }) => {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cloudBaseUrl: "http://127.0.0.1:8892" }),
      });
      const response = await fetch("/api/remote/auth/web/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get("set-cookie"),
      };
    },
    { username, password },
  );
  assert.equal(login.status, 200);
  assert(!login.body.token);
  assert.equal(login.cookie, null);
  const settings = await page.evaluate(
    async () => await (await fetch("/api/settings")).json(),
  );
  assert.equal(settings.cloudToken, "");
  assert(settings.cloudTokenConfigured);
  const stored = JSON.parse(
    await readFile(join(profile, "data/settings.json"), "utf8"),
  );
  assert.equal(stored.cloudToken, "");
  checks.push(
    "Desktop password login stores opaque cloud session only in native vault; no token or Set-Cookie reaches renderer/plain settings",
  );
  await desktop.close();
  desktop = undefined;
  page = await launch();
  const me = await page.evaluate(async () => {
    const r = await fetch("/api/remote/v1/me");
    return { status: r.status, body: await r.json() };
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.id, ownerId);
  checks.push(
    "Restart restores authenticated remote connection from native vault",
  );
  const logout = await page.evaluate(async () => {
    const r = await fetch("/api/remote/auth/web/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  assert.equal(logout, 200);
  const after = await page.evaluate(
    async () => await (await fetch("/api/settings")).json(),
  );
  assert.equal(after.cloudTokenConfigured, false);
  checks.push(
    "Desktop logout revokes cloud session and clears native vault connection credential",
  );
  let releaseLogin, markLogin;
  const arrived = new Promise((resolve) => {
    markLogin = resolve;
  });
  const released = new Promise((resolve) => {
    releaseLogin = resolve;
  });
  const fixtureToken = "c".repeat(64),
    revoked = [];
  authFixture = createServer(async (req, res) => {
    if (req.url === "/auth/web/login") {
      markLogin();
      await released;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `pig_web_session=${fixtureToken}; HttpOnly; SameSite=Strict`,
      });
      res.end(JSON.stringify({ account: { id: "race-fixture" } }));
    } else {
      revoked.push(req.headers.cookie);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  await new Promise((resolve) => authFixture.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${authFixture.address().port}`;
  await page.evaluate(async (url) => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloudBaseUrl: url }),
    });
    window.__pendingLogin = fetch("/api/remote/auth/web/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "race-fixture",
        password: "fixture-password",
      }),
    }).then((r) => r.status);
  }, fixtureUrl);
  await arrived;
  await page.evaluate(() => {
    window.__pendingLogout = fetch("/api/remote/auth/web/logout", {
      method: "POST",
      body: "{}",
    }).then((r) => r.status);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseLogin();
  const race = await page.evaluate(async () => ({
    login: await window.__pendingLogin,
    logout: await window.__pendingLogout,
    settings: await (await fetch("/api/settings")).json(),
  }));
  assert.equal(race.login, 409);
  assert.equal(race.logout, 200);
  assert.equal(race.settings.cloudTokenConfigured, false);
  assert(revoked.includes("pig_web_session=" + fixtureToken));
  checks.push(
    "Real Electron held-response race: logout supersedes pending login, late session revoked, login returns409, vault remains cleared",
  );
  await mkdir("data/password-account-evidence", { recursive: true });
  await writeFile(
    "data/password-account-evidence/desktop-password.json",
    JSON.stringify(
      { at: new Date().toISOString(), checks, profile: "isolated and removed" },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  authFixture?.closeAllConnections();
  authFixture?.close();
  await desktop?.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    const p = spawn(
      "docker",
      [
        "exec",
        "-i",
        "pig-agent-cluster-postgres-1",
        "sh",
        "-c",
        'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code ? reject(Error(err)) : resolve()));
    p.stdin.end(
      `DELETE FROM auth_sessions WHERE owner_id='${ownerId || "none"}'; DELETE FROM registration_requests WHERE username='${username}'; DELETE FROM password_accounts WHERE username='${username}'; DELETE FROM principals WHERE id='${ownerId || "none"}';`,
    );
  });
}
