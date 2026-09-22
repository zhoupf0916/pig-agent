import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8892",
  out = "data/cloud-workspace-evidence";
await mkdir(out, { recursive: true });
const secrets = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx1 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  }),
  ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const a = await ctx1.newPage(),
  b = await ctx2.newPage(),
  errors = [];
for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
const request = async (ctx, path, method = "GET", data) => {
  const r = await ctx.request.fetch(base + path, {
    method,
    data,
    headers: { Origin: base },
  });
  if (!r.ok()) throw Error(path + " " + r.status() + " " + (await r.text()));
  return r.json();
};
async function login(page, token) {
  await page.goto(base);
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await expect(page.getByLabel("任务消息")).toBeVisible();
}
const name = "UI协作 " + Date.now();
const checks = [];
try {
  await login(a, secrets.MEMBER_TOKEN);
  await login(b, secrets.MEMBER2_TOKEN);
  await a.screenshot({ path: out + "/empty-desktop.png" });
  await a.getByRole("button", { name: "空间与成员", exact: true }).click();
  const dialog = a.getByRole("dialog", { name: "空间与成员" });
  await dialog.getByText("创建组织", { exact: true }).first().click();
  await dialog.getByLabel("组织名称", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "创建组织", exact: true }).click();
  await expect(dialog.getByLabel("新项目名称")).toBeVisible();
  await dialog.getByText("邀请已有账号加入组织", { exact: true }).click();
  await dialog.getByLabel("成员权限").selectOption("editor");
  await dialog.getByRole("button", { name: "生成一次性邀请码" }).click();
  const invite = await dialog.getByLabel("24 小时有效").inputValue();
  await b.getByRole("button", { name: "空间与成员", exact: true }).click();
  const bd = b.getByRole("dialog", { name: "空间与成员" });
  await bd.getByText("使用组织邀请码加入", { exact: true }).click();
  await bd.getByLabel("组织邀请码", { exact: true }).fill(invite);
  await bd.getByRole("button", { name: "加入组织", exact: true }).click();
  await bd.getByRole("button", { name: "关闭空间管理" }).click();
  await dialog.getByLabel("新项目名称").fill("共同交付");
  await dialog
    .getByLabel("共享背景")
    .fill("团队共同检查 cloud-proof.txt，文件结果必须与实际读取一致。");
  await dialog
    .getByRole("button", { name: "创建共享项目", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await a
    .getByLabel("任务消息")
    .fill("请创建并读回 cloud-proof.txt，报告实际结果。");
  await a.getByRole("button", { name: "发送消息" }).click();
  await expect(a).toHaveURL(/conv_/);
  const link = a.url();
  await b.goto(link);
  await expect(
    b.getByRole("heading", {
      name: "请创建并读回 cloud-proof.txt，报告实际结果。",
      exact: true,
    }),
  ).toBeVisible();
  await expect(b.locator(".cw-message.user")).toContainText(
    "请创建并读回 cloud-proof.txt",
  );
  await expect(
    a.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await a.screenshot({ path: out + "/approval-desktop.png" });
  await b.screenshot({ path: out + "/collaborator-desktop.png" });
  await b.evaluate(() => {
    window.__partials = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector('[aria-busy="true"]')?.textContent;
      if (text && !window.__partials.includes(text))
        window.__partials.push(text);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await a.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect(a.locator(".cw-state")).toHaveText("已完成", { timeout: 60000 });
  await expect(b.locator(".cw-state")).toHaveText("已完成", { timeout: 10000 });
  assert.ok(
    (await b.evaluate(() => window.__partials.length)) >= 2,
    "peer sees progressive output before terminal",
  );
  assert.equal(
    await b.locator(".cw-message.assistant").count(),
    1,
    "no replay duplicates",
  );
  await b.reload();
  await expect(b.locator(".cw-state")).toHaveText("已完成");
  await expect(b.locator(".cw-message.assistant")).toHaveCount(1);
  await a.getByRole("button", { name: "成果与过程", exact: true }).click();
  await a.getByRole("button", { name: "cloud-proof.txt", exact: true }).click();
  await expect(a.locator(".cw-resource-body pre")).toContainText(
    "PIG_CLOUD_CONTAINER_OK",
  );
  await a.screenshot({ path: out + "/artifact-desktop.png" });
  await a.getByRole("button", { name: "关闭成果" }).click();
  await a.setViewportSize({ width: 390, height: 844 });
  await a.screenshot({ path: out + "/conversation-mobile.png" });
  assert.ok(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await b.getByLabel("任务消息").fill("继续读取刚才的文件。");
  await b.getByRole("button", { name: "发送消息" }).click();
  await expect(
    a.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await a.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect(b.locator(".cw-state")).toHaveText("已完成", { timeout: 60000 });
  checks.push(
    "two separate accounts log in with cookie sessions",
    "create organization/project with shared background and editor join through actual UI",
    "peer opens conversation deep link and sees prompt during running",
    "peer receives progressive text before terminal; refresh does not duplicate final reply",
    "cloud artifact preview content matches real container output",
    "second user continues same conversation and first user approves",
    "desktop and mobile actual screenshots; no horizontal overflow",
  );
  await a.setViewportSize({ width: 1440, height: 900 });
  const privateSpace = await request(ctx1, "/v1/spaces", "POST", {
    name: "隔离元数据 " + Date.now(),
  });
  await request(ctx1, "/v1/shared-projects", "POST", {
    spaceId: privateSpace.id,
    name: "仅账号A可见",
  });
  await expect(a.locator(".cw-project-label select")).toContainText(
    "仅账号A可见",
    { timeout: 10000 },
  );
  let release, capturedResolve;
  const captured = new Promise((resolve) => (capturedResolve = resolve));
  let intercepted = false;
  await a.route("**/v1/shared-projects", async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    capturedResolve();
    await new Promise((resolve) => (release = resolve));
    await route.fulfill({ response });
  });
  await captured;
  await a.getByRole("button", { name: "退出登录" }).click();
  await a.getByLabel("访问令牌").fill(secrets.MEMBER2_TOKEN);
  await a.getByRole("button", { name: "进入工作台", exact: true }).click();
  await expect(a.getByLabel("任务消息")).toBeVisible();
  release();
  await a.waitForTimeout(400);
  await expect(a.locator(".cw-project-label select")).not.toContainText(
    "仅账号A可见",
  );
  checks.push(
    "held pre-logout project response cannot repopulate old-account metadata after login as another account without page reload",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/report.json",
    JSON.stringify({ checks, conversationUrl: link, errors }, null, 2),
  );
} finally {
  await browser.close();
}
