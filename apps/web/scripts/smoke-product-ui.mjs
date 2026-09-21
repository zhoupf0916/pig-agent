// Run against the isolated acceptance server on :8798; never the user's :8797 data.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const base = process.env.PIG_WORKBENCH_URL || "http://127.0.0.1:8798";
const data = resolve(
  process.env.PIG_TEST_DATA_DIR || "data/product-acceptance",
);
const evidence = resolve("data/product-evidence");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
let fixturePath;
try {
  await page.goto(base);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: `${evidence}/settings-mobile.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开导航", exact: true }),
  ).toBeFocused();
  // Editing a real setting stays a draft until explicit save; closing must not silently discard it.
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", {
    name: "设置",
    exact: true,
  });
  await settingsDialog.getByRole("button", { name: /^工作区/ }).click();
  const workspaceInput = settingsDialog.getByRole("textbox", {
    name: /^工作区根目录/,
  });
  const savedWorkspace = await workspaceInput.inputValue();
  await workspaceInput.fill(savedWorkspace + "-unsaved-fixture");
  await settingsDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(workspaceInput).toHaveValue(savedWorkspace + "-unsaved-fixture");
  await settingsDialog
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page
    .getByRole("button", { name: "放弃修改并关闭", exact: true })
    .click();
  assert.equal(
    (await (await page.request.get(`${base}/api/settings`)).json())
      .workspaceRoot,
    savedWorkspace,
  );
  console.log(
    "PASS 390×844 settings footer, keyboard containment, Escape, return focus",
  );

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "远端记录", exact: true }).click();
  const remote = page.getByRole("region", { name: "远端运行记录" });
  await expect(
    remote.getByText("正在读取运行记录…", { exact: true }),
  ).toHaveCount(0, { timeout: 15000 });
  const remoteSearch = remote.getByRole("textbox", { name: "搜索远端运行" });
  await remoteSearch.fill("没有匹配的远端任务 729");
  await expect(remote.locator("aside button")).toHaveCount(0);
  await remoteSearch.fill("");
  await remote
    .getByRole("combobox", { name: "筛选运行状态" })
    .selectOption("all");
  if (await remote.locator("aside button").count()) {
    await remote.locator("aside button").first().click();
    await expect(remote.getByText("任务目标", { exact: true })).toBeVisible({
      timeout: 15000,
    });
  }
  await page.screenshot({
    path: `${evidence}/remote-runs-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    remote.getByRole("button", { name: "返回工作台", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: `${evidence}/remote-runs-mobile.png`,
    fullPage: true,
  });
  await page.route("**/api/remote/v1/**", (route) => route.abort("failed"));
  await expect(remote.getByText(/暂时无法同步控制面/)).toBeVisible({
    timeout: 15000,
  });
  await page.unroute("**/api/remote/v1/**");
  await expect(remote.getByText(/暂时无法同步控制面/)).toHaveCount(0, {
    timeout: 15000,
  });
  await remote.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(remote).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  console.log(
    "PASS remote search/filter, responsive details, disconnect/reconnect recovery",
  );
  const response = await page.request.post(`${base}/api/sessions`, {
    data: {},
    headers: { Origin: base },
  });
  assert.equal(response.status(), 201);
  const created = await response.json();
  fixturePath = resolve(data, "sessions", `${created.id}.json`);
  // Verify this really is the isolated data directory before changing any fixture.
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.id, created.id);
  fixture.title = "UI 验收夹具：长会话阅读";
  fixture.messages = Array.from({ length: 40 }, (_, i) => ({
    id: `msg_ux_${i}`,
    role: i % 2 ? "assistant" : "user",
    content: `第 ${i + 1} 条测试消息\n\n用于验证长会话阅读位置，不代表 Agent 执行结果。\n\n任务过程应保持可读，查看历史消息时不会被新的输出强制拉回底部。`,
    createdAt: new Date().toISOString(),
  }));
  await writeFile(fixturePath, JSON.stringify(fixture));
  await page.goto(`${base}/#/sessions/${created.id}`);
  await expect(
    page.getByText("第 40 条测试消息", { exact: false }),
  ).toBeVisible();
  const search = page.getByRole("textbox", { name: "搜索本地任务" });
  await search.fill("不存在的任务 729");
  await expect(
    page.getByText("没有匹配的任务。", { exact: true }),
  ).toBeVisible();
  await search.fill("长会话阅读");
  await expect(
    page.getByRole("button", { name: /UI 验收夹具：长会话阅读/ }).first(),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "筛选本地任务" })
    .selectOption("running");
  await expect(
    page.getByText("没有匹配的任务。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "筛选本地任务" })
    .selectOption("all");
  const transcript = page.locator(".transcript");
  await transcript.evaluate((el) => {
    el.scrollTop = 120;
  });
  await expect(
    page.getByRole("button", { name: "回到最新消息 ↓" }),
  ).toBeVisible();
  const before = await transcript.evaluate((el) => el.scrollTop);
  fixture.messages.push({
    id: "msg_ux_new",
    role: "assistant",
    content: "这是随后到达的新消息，用于验收阅读位置。",
    createdAt: new Date().toISOString(),
  });
  fixture.updatedAt = new Date().toISOString();
  await writeFile(fixturePath, JSON.stringify(fixture));
  await page.locator('.session-sidebar button[aria-current="true"]').click();
  await expect(
    page.getByText("这是随后到达的新消息，用于验收阅读位置。", { exact: true }),
  ).toBeAttached({ timeout: 10000 });
  assert.ok(
    Math.abs((await transcript.evaluate((el) => el.scrollTop)) - before) < 3,
    "New message must preserve scrolled-up reading position",
  );
  await page.screenshot({
    path: `${evidence}/workbench-reading.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "回到最新消息 ↓" }).click();
  await expect(
    page.getByText("这是随后到达的新消息，用于验收阅读位置。", { exact: true }),
  ).toBeInViewport();
  console.log(
    "PASS task search, state filters, new message preserves reading position, jump to latest",
  );
  assert.deepEqual(failures, [], "No browser runtime errors");
} finally {
  await browser.close();
  if (fixturePath) await unlink(fixturePath).catch(() => {});
}
