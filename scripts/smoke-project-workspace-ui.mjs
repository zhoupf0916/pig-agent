import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8892",
  out = "data/project-ui-evidence";
await mkdir(out, { recursive: true });
const secrets = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
const stamp = Date.now();
const accounts = [
  {
    username: "ui" + stamp + "a",
    password: "UI-acceptance-" + stamp,
    name: "林编辑",
  },
  {
    username: "ui" + stamp + "b",
    password: "UI-acceptance-" + stamp,
    name: "周协作者",
  },
];
async function admin(path, method = "GET", body) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + secrets.ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(r.ok, path);
  return r.json();
}
async function approve(username) {
  const list = await admin("/v1/admin/registration-requests");
  const item = list.requests.find((a) => a.username === username);
  assert.ok(item);
  await admin(
    "/v1/admin/registration-requests/" + item.id + "/decision",
    "POST",
    { decision: "approve" },
  );
}
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
  ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
  a = await ctx1.newPage(),
  b = await ctx2.newPage();
const errors = [];
for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
const checks = [];
async function register(page, account) {
  await page.goto(base);
  await page.getByRole("button", { name: "申请账号", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByLabel("显示名称", { exact: true }).fill(account.name);
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("申请已提交");
}
async function login(page, account) {
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByLabel("任务消息")).toBeVisible();
}
async function finish(page) {
  await expect(
    page.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect(page.locator(".cw-state")).toHaveText("已完成", {
    timeout: 60000,
  });
}
try {
  await a.goto(base);
  await a.screenshot({ path: out + "/login-desktop.png" });
  await register(a, accounts[0]);
  await a.getByLabel("密码", { exact: true }).fill(accounts[0].password);
  await a.getByRole("button", { name: "登录", exact: true }).click();
  await expect(a.getByRole("alert")).toBeVisible();
  await approve(accounts[0].username);
  await login(a, accounts[0]);
  checks.push(
    "username/password application awaits approval; pending account cannot log in; approved login succeeds",
  );
  await a.getByRole("button", { name: "新建项目", exact: true }).click();
  const pd = a.getByRole("dialog", { name: "新建项目" });
  await pd.getByLabel("项目名称", { exact: true }).fill("内容准备");
  await pd.getByLabel("项目背景").fill("所有输出以实际文件为依据");
  await pd.getByLabel("工作区名称").fill("内容工作区");
  await pd.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(pd).toHaveCount(0);
  await a.getByLabel("网络访问策略").selectOption("blocked");
  await a.screenshot({ path: out + "/personal-project-desktop.png" });
  await a.getByLabel("任务消息").fill("创建并读回 cloud-proof.txt。");
  await a.getByRole("button", { name: "发送消息" }).click();
  await finish(a);
  await a.getByRole("button", { name: "内容工作区", exact: true }).click();
  await expect(
    a.getByRole("heading", { name: "内容工作区", exact: true }),
  ).toBeVisible();
  await expect(a.locator(".cw-resource-body")).toContainText("1 个版本");
  await a
    .locator(".cw-resource-body details")
    .last()
    .locator("summary")
    .click();
  await expect(
    a.getByRole("link", { name: "下载工作区版本", exact: true }),
  ).toBeVisible();
  await a.screenshot({ path: out + "/workspace-desktop.png" });
  await a.getByRole("button", { name: "关闭成果" }).click();
  checks.push(
    "personal project has persistent named workspace; real completed container run adds downloadable file version",
  );
  await register(b, accounts[1]);
  await approve(accounts[1].username);
  await login(b, accounts[1]);
  await a.getByRole("button", { name: "项目协同", exact: true }).click();
  await a.getByRole("button", { name: "协作成员与项目", exact: true }).click();
  const d = a.getByRole("dialog", { name: "共享项目" });
  await d.getByText("创建组织", { exact: true }).first().click();
  await d.getByLabel("组织名称", { exact: true }).fill("内容团队" + stamp);
  await d.getByRole("button", { name: "创建组织", exact: true }).click();
  await expect(d.getByLabel("新项目名称")).toBeVisible();
  await d.getByText("邀请已有账号加入组织", { exact: true }).click();
  await d.getByLabel("成员权限").selectOption("editor");
  await d.getByRole("button", { name: "生成一次性邀请码" }).click();
  const invitation = await d.getByLabel("24 小时有效").inputValue();
  await b.getByRole("button", { name: "项目协同", exact: true }).click();
  await b.getByRole("button", { name: "协作成员与项目", exact: true }).click();
  const bd = b.getByRole("dialog", { name: "共享项目" });
  await bd.getByText("使用组织邀请码加入", { exact: true }).click();
  await bd.getByLabel("组织邀请码", { exact: true }).fill(invitation);
  await bd.getByRole("button", { name: "加入组织", exact: true }).click();
  await bd.getByRole("button", { name: "关闭空间管理" }).click();
  await d.getByLabel("新项目名称").fill("共同交付");
  await d.getByLabel("共享背景").fill("两位成员共同核验文件。");
  await d.getByRole("button", { name: "创建共享项目", exact: true }).click();
  await expect(d).toHaveCount(0);
  await a
    .getByLabel("任务消息")
    .fill("请创建并读回 cloud-proof.txt，检查协作执行。");
  await a.getByRole("button", { name: "发送消息" }).click();
  await expect(a).toHaveURL(/conv_/);
  const link = a.url();
  await b.goto(link);
  await expect(b.locator(".cw-message.user")).toContainText("林编辑");
  await expect(
    b.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await b.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect(a.locator(".cw-state")).toHaveText("已完成", { timeout: 60000 });
  await expect(b.locator(".cw-message.assistant")).toHaveCount(1);
  await a.screenshot({ path: out + "/collaboration-desktop.png" });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: out + "/collaboration-mobile.png" });
  assert.ok(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  checks.push(
    "project collaboration stays a project branch; two password accounts share authors, approvals and results; mobile has no overflow",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/accounts.json",
    JSON.stringify({ accounts, conversationUrl: link }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    out + "/report.json",
    JSON.stringify({ checks, conversationUrl: link, errors }, null, 2),
  );
} finally {
  await browser.close();
}
