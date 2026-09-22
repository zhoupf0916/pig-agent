import { chromium, expect } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8892",
  tag = randomUUID().replaceAll("-", "").slice(0, 12),
  adminId = "review_admin_" + tag,
  adminToken = randomBytes(32).toString("hex"),
  password = randomBytes(18).toString("base64url"),
  username = "member_" + tag,
  adminName = "admin_" + tag;
const psql = (input) =>
  new Promise((resolve, reject) => {
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
    p.on("exit", (code) => (code ? reject(Error(err)) : resolve(out)));
    p.stdin.end(input);
  });
async function api(path, body, token = adminToken) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
let browser, ownerId;
const checks = [];
const evidence = "data/password-account-evidence";
await mkdir(evidence, { recursive: true });
try {
  await psql(
    `INSERT INTO principals(id,name,role,token_hash) VALUES('${adminId}','Approval review administrator','admin','${createHash("sha256").update(adminToken).digest("hex")}');`,
  );
  assert.equal(
    (await api("/v1/admin/password-account", { username: adminName, password }))
      .status,
    200,
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const userContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    }),
    adminContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
  const user = await userContext.newPage(),
    admin = await adminContext.newPage();
  await user.goto(base);
  await user.getByRole("button", { name: "申请账号", exact: true }).click();
  await user.getByLabel("用户名", { exact: true }).fill(username);
  await user.getByLabel("密码", { exact: true }).fill(password);
  await user
    .getByLabel("显示名称", { exact: true })
    .fill("Account acceptance applicant");
  await user
    .getByLabel("申请说明（选填）")
    .fill("Isolated registration and approval validation");
  await user.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(user.getByRole("status")).toContainText("管理员");
  await user.screenshot({ path: evidence + "/application-submitted.png" });
  checks.push("User submits account/password application through real browser");
  const pending = await fetch(base + "/auth/web/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(pending.status, 401);
  checks.push("Pending application cannot log in");
  await admin.goto(base + "/admin/#accounts");
  await admin.getByLabel("管理员账号", { exact: true }).fill(adminName);
  await admin.getByLabel("密码", { exact: true }).fill(password);
  await admin
    .getByRole("button", { name: "登录管理后台", exact: true })
    .click();
  await expect(admin.locator("#dashboard")).toBeVisible();
  const card = admin
    .locator("#registration-requests")
    .locator("div")
    .filter({ hasText: username })
    .first();
  await expect(card.getByRole("button", { name: "批准账号" })).toBeVisible();
  await admin.screenshot({ path: evidence + "/admin-pending.png" });
  const mobileAdmin=await adminContext.newPage();
  await mobileAdmin.setViewportSize({width:390,height:844});
  await mobileAdmin.goto(base+'/admin/#accounts');
  await expect(mobileAdmin.locator('#registration-requests').getByRole('button',{name:'批准账号'}).first()).toBeVisible();
  assert(await mobileAdmin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile admin must not overflow horizontally');
  await mobileAdmin.screenshot({path:evidence+'/admin-pending-mobile.png'});
  await mobileAdmin.close();
  checks.push('390×844 mobile admin approval controls visible; no horizontal overflow');
  await card.getByRole("button", { name: "批准账号" }).click();
  await expect(admin.locator("#feedback")).toContainText("批准");
  checks.push(
    "Administrator logs in by password and approves in actual admin UI",
  );
  const rows = await (await api("/v1/admin/registration-requests")).json();
  const request = rows.requests.find((r) => r.username === username);
  ownerId = request.owner_id;
  assert.equal(request.state, "approved");
  assert(!JSON.stringify(rows).includes("password_hash"));
  assert.equal(
    (
      await api(`/v1/admin/registration-requests/${request.id}/decision`, {
        decision: "approve",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(`/v1/admin/registration-requests/${request.id}/decision`, {
        decision: "reject",
      })
    ).status,
    409,
  );
  checks.push(
    "Approval is idempotent; conflicting repeated decision rejected; no password hashes in list",
  );
  await user.getByRole("button", { name: "账号登录", exact: true }).click();
  await user.getByLabel("用户名", { exact: true }).fill(username);
  await user.getByLabel("密码", { exact: true }).fill(password);
  await user.getByRole("button", { name: "登录", exact: true }).click();
  await expect(user.locator(".cw-shell")).toBeVisible();
  await user.reload();
  await expect(user.locator(".cw-shell")).toBeVisible();
  await user.screenshot({ path: evidence + "/user-approved-login.png" });
  checks.push(
    "Approved user logs in with original password; reload keeps session",
  );
  assert.equal(
    (
      await userContext.request.get(base + "/v1/admin/registration-requests")
    ).status(),
    403,
  );
  checks.push("Member cannot access admin approval API");
  const rejectedName = "reject_" + tag;
  assert.equal(
    (
      await api("/auth/web/register", {
        username: rejectedName,
        password,
        name: "Rejected fixture",
      })
    ).status,
    201,
  );
  const rejectRows = await (
    await api("/v1/admin/registration-requests")
  ).json();
  const rejected = rejectRows.requests.find((r) => r.username === rejectedName);
  assert.equal(
    (
      await api(`/v1/admin/registration-requests/${rejected.id}/decision`, {
        decision: "reject",
        reason: "Fixture rejection",
      })
    ).status,
    200,
  );
  assert.equal(
    (await api("/auth/web/login", { username: rejectedName, password })).status,
    401,
  );
  checks.push("Rejected application cannot log in");
  const bad = await api("/auth/web/login", {
    username,
    password: "incorrect-password",
  });
  assert.equal(bad.status, 401);
  const stored = await psql(
    `SELECT password_hash FROM password_accounts WHERE username='${username}';`,
  );
  assert(stored.startsWith("scrypt$16384$8$1$"));
  assert(!stored.includes(password));
  await user.getByRole("button", { name: "退出登录" }).click();
  await expect(user.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  checks.push(
    "Wrong password rejected; persisted password is salted scrypt; logout works",
  );
  await writeFile(
    evidence + "/flow.json",
    JSON.stringify({ at: new Date().toISOString(), base, checks }, null, 2),
  );
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  await browser?.close();
  await psql(
    `DELETE FROM auth_sessions WHERE owner_id IN (SELECT owner_id FROM password_accounts WHERE username IN ('${username}','${adminName}')); DELETE FROM registration_requests WHERE username IN ('${username}','reject_${tag}'); DELETE FROM password_accounts WHERE username IN ('${username}','${adminName}'); DELETE FROM principals WHERE id IN ('${adminId}','${ownerId || "none"}');`,
  );
}
