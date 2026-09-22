import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.ADMIN_UI_URL || "http://127.0.0.1:8892";
const env = await readFile(
  process.env.ADMIN_UI_ENV || "data/cluster-local/stack.env",
  "utf8",
);
const token = env.match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
assert(token, "Admin token must exist in the local environment file");
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
async function navigateTo(name) {
  if (page.viewportSize().width <= 700)
    await page
      .getByRole("button", { name: "打开管理导航", exact: true })
      .click();
  await page.getByRole("link", { name, exact: true }).click();
}
let originalQueueTimeout;
let invitationFixtureId;
const pendingInvites = new Set();
async function adminApi(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, "Fixture API request must succeed");
  return response.json();
}
async function delayedInviteAfterLogout(trigger) {
  let release, ready;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const responseReady = new Promise((resolve) => {
    ready = resolve;
  });
  let invite;
  await page.route("**/v1/admin/invitations", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 201, "Real invitation was created");
    invite = (await response.json()).invite;
    pendingInvites.add(invite);
    ready();
    await held;
    await route.fulfill({ response });
  });
  try {
    await trigger();
    let timeout;
    try {
      await Promise.race([
        responseReady,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Timed out waiting for real invitation response"),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.locator("#login").waitFor({ state: "visible" });
    const completed = page.waitForResponse((response) =>
      response.url().endsWith("/v1/admin/invitations"),
    );
    release();
    await completed;
    // Allow the response body and its UI continuation to settle before asserting.
    await page.waitForTimeout(150);
    assert.equal(
      await page.locator("#invite-result").textContent(),
      "",
      "Late invitation must not reappear after logout",
    );
    assert(
      await page.locator("#feedback").isHidden(),
      "Late success feedback must not reappear after logout",
    );
    return invite;
  } finally {
    release();
    await page.unroute("**/v1/admin/invitations");
  }
}
async function loginAgain() {
  if (!(await page.getByLabel("管理员令牌").isVisible()))
    await page.getByText("首次部署 / 内部令牌登录", { exact: true }).click();
  await page.getByLabel("管理员令牌").fill(token);
  await page.getByRole("button", { name: "连接平台", exact: true }).click();
  await page.locator("#dashboard").waitFor({ state: "visible" });
  await navigateTo("账号与配额");
}
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("data/product-evidence", { recursive: true });
try {
  await page.goto(base + "/admin/");
  await page.getByText("首次部署 / 内部令牌登录", { exact: true }).click();
  await page.getByLabel("管理员令牌").fill("invalid-token");
  await page.getByRole("button", { name: "连接平台", exact: true }).click();
  await page.locator("#error").waitFor({ state: "visible" });
  await page.getByLabel("管理员令牌").fill(token);
  await page.getByRole("button", { name: "连接平台", exact: true }).click();
  await page.locator("#dashboard").waitFor({ state: "visible" });
  await page.screenshot({
    path: "data/product-evidence/admin-overview.png",
    fullPage: true,
  });
  await navigateTo("Runner 集群");
  await page.locator('[data-view="workers"]').waitFor({ state: "visible" });
  await page.locator("#workers .worker-row").first().waitFor();
  assert(
    (await page.locator("#workers .worker-row").count()) >= 2,
    "Two online Runner rows",
  );
  await page.screenshot({
    path: "data/product-evidence/admin-runners.png",
    fullPage: true,
  });
  await navigateTo("执行与模型");
  assert(Number(await page.locator("#global-concurrency").inputValue()) > 0);
  if (process.env.ADMIN_UI_MUTATE === "1") {
    const original = await page.locator("#queue-timeout").inputValue();
    originalQueueTimeout = Number(original);
    const next = original === "3600" ? "3601" : "3600";
    await page.locator("#queue-timeout").fill(next);
    await page.getByRole("button", { name: "保存调度设置" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "调度设置已保存" })
      .waitFor();
    await page.reload();
    await page.locator("#dashboard").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#queue-timeout").inputValue(),
      next,
      "Saved setting survives reload",
    );
    await page.locator("#queue-timeout").fill(original);
    await page.getByRole("button", { name: "保存调度设置" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "调度设置已保存" })
      .waitFor();
    originalQueueTimeout = undefined;
  }
  await page.screenshot({
    path: "data/product-evidence/admin-settings.png",
    fullPage: true,
  });
  await navigateTo("账号与配额");
  await page.locator('[data-view="accounts"]').waitFor({ state: "visible" });
  const quotaInputs = page.locator('#accounts input[type="number"]');
  if ((await quotaInputs.count()) >= 2) {
    await quotaInputs.nth(0).fill("1001");
    await quotaInputs.nth(1).fill("1002");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    assert.equal(await quotaInputs.nth(0).inputValue(), "1001");
    assert.equal(await quotaInputs.nth(1).inputValue(), "1002");
    await page
      .locator("#accounts article")
      .nth(0)
      .getByRole("button", { name: "还原", exact: true })
      .click();
    await page
      .locator("#accounts article")
      .nth(1)
      .getByRole("button", { name: "还原", exact: true })
      .click();
  }
  await page.screenshot({
    path: "data/product-evidence/admin-accounts.png",
    fullPage: true,
  });
  await navigateTo("计划与审计");
  await page.locator('[data-view="audit"]').waitFor({ state: "visible" });
  await page.screenshot({
    path: "data/product-evidence/admin-audit.png",
    fullPage: true,
  });
  await navigateTo("任务与日志");
  await page
    .getByRole("searchbox", { name: "搜索任务" })
    .fill("no-match-for-admin-smoke-938485");
  await page.getByText("没有符合条件的任务", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "搜索任务" }).fill("");
  const details = page.getByRole("button", { name: "详情与日志" });
  assert(
    await details.count(),
    "Run cluster:smoke first to seed a real execution record",
  );
  {
    const succeeded = page
      .locator("#runs tr")
      .filter({ has: page.locator(".badge.succeeded") });
    await (
      (await succeeded.count())
        ? succeeded.first().getByRole("button", { name: "详情与日志" })
        : details.first()
    ).click();
    await page
      .getByRole("heading", { name: "执行日志 · 最近 200 条" })
      .waitFor();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载日志 JSON" }).click();
    const download = await downloaded;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert(
      Array.isArray(JSON.parse(Buffer.concat(chunks).toString())),
      "Event log download is real JSON",
    );
    await page.screenshot({
      path: "data/product-evidence/admin-run-detail.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "关闭任务详情" }).click();
  }
  await page.route("**/v1/admin/overview", (route) => route.abort());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("连接中断 · 正在自动重试", { exact: true }).waitFor();
  assert(
    await page.locator("#dashboard").isVisible(),
    "Connection errors preserve existing dashboard",
  );
  await page.unroute("**/v1/admin/overview");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("● 控制面已连接", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await navigateTo("Runner 集群");
  await page.locator('[data-view="workers"]').waitFor({ state: "visible" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "No horizontal page overflow on mobile",
  );
  await page.screenshot({
    path: "data/product-evidence/admin-mobile.png",
    fullPage: true,
  });
  for (const [name, view] of [
    ["执行与模型", "settings"],
    ["账号与配额", "accounts"],
    ["任务与日志", "runs"],
    ["计划与审计", "audit"],
  ]) {
    await navigateTo(name);
    await page.locator(`[data-view="${view}"]`).waitFor({ state: "visible" });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name}: no horizontal page overflow`,
    );
  }
  await navigateTo("账号与配额");
  await page
    .getByText("高级兼容方式：设备邀请与内部令牌", { exact: true })
    .click();
  const fixtureName = `UI delayed invitation ${Date.now()}`;
  const invite = await delayedInviteAfterLogout(async () => {
    await page.getByLabel("新账号名称").fill(fixtureName);
    await page.getByRole("button", { name: "创建 24 小时邀请" }).click();
  });
  // Logout hides the secret; it does not revoke an already-created invitation.
  const accepted = await adminApi("/auth/accept-invite", { invite });
  pendingInvites.delete(invite);
  invitationFixtureId = accepted.account.id;
  await loginAgain();
  await delayedInviteAfterLogout(() =>
    page
      .locator("#accounts article")
      .filter({
        has: page.getByRole("heading", { name: fixtureName, exact: true }),
      })
      .getByRole("button", { name: "新设备登录 / 续期" })
      .click(),
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  const result = {
    ok: true,
    base,
    testedAt: new Date().toISOString(),
    mutation: process.env.ADMIN_UI_MUTATE === "1",
    checks: [
      "invalid login",
      "valid login",
      "two online Runner rows",
      "settings load",
      "account drafts survive refresh",
      "all six management pages",
      ...(process.env.ADMIN_UI_MUTATE === "1"
        ? ["settings saved and persisted after reload; original restored"]
        : []),
      "task search empty state",
      "task detail and event log",
      "event log JSON download",
      "network failure preserves dashboard",
      "connection recovery",
      "390px responsive layout",
      "logout",
      "delayed new-member and device-renewal invitations stay hidden after logout",
      "no browser runtime errors",
    ],
  };
  await writeFile(
    "data/product-evidence/admin-ui.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  for (const invite of pendingInvites) {
    const accepted = await adminApi("/auth/accept-invite", { invite });
    await fetch(base + `/v1/admin/accounts/${accepted.account.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false, revokeSessions: true }),
    });
  }
  if (invitationFixtureId)
    await fetch(base + `/v1/admin/accounts/${invitationFixtureId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false, revokeSessions: true }),
    });
  if (originalQueueTimeout !== undefined) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const current = await fetch(base + "/v1/admin/execution-policy", {
      headers,
    }).then((r) => r.json());
    const restored = await fetch(base + "/v1/admin/execution-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ...current,
        queueTimeoutSeconds: originalQueueTimeout,
      }),
    });
    assert(
      restored.ok,
      "Restore original queue timeout after test interruption",
    );
  }
  await browser.close();
}
