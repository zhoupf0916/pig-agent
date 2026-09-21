import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const evidence = "data/product-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:8798/");
  const createdResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  const created = await (await createdResponse).json();
  await page.waitForURL("**/#/sessions/" + created.id);
  await expect(page.getByLabel("执行位置")).toBeVisible();
  await page.getByLabel("执行位置").selectOption("remote");
  await page.getByLabel("写入前审批").click();
  await expect(page.getByLabel("写入前审批")).toBeChecked();
  await page
    .getByPlaceholder(/描述目标/)
    .fill("产品验收：请创建并读回 cloud-proof.txt，核验容器执行成果。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(/等待审批，尚未执行/).first()).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole("button", { name: "远端运行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "远端运行记录" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: /产品验收/ })
    .first()
    .click();
  await expect(dialog.getByRole("button", { name: "批准此操作" })).toBeVisible({
    timeout: 10000,
  });
  await page.screenshot({
    path: evidence + "/flow-approval.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "批准此操作" }).click();
  const file = dialog.getByRole("link", {
    name: "cloud-proof.txt",
    exact: true,
  });
  await expect(file).toBeVisible({ timeout: 45000 });
  const downloadPromise = page.waitForEvent("download");
  await file.click();
  const download = await downloadPromise;
  assert.equal(
    (await readFile(await download.path(), "utf8")).trim(),
    "PIG_CLOUD_CONTAINER_OK",
  );
  await page.screenshot({
    path: evidence + "/flow-result.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "在工作台继续会话" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("执行位置")).toHaveValue("remote");
  await expect(page.getByText(/容器执行验收通过/).first()).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByPlaceholder(/描述目标/)
    .fill("继续核验刚才的文件，报告已保存的结果。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/等待审批，尚未执行/).last()).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole("button", { name: "远端运行", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "批准此操作" })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole("button", { name: "批准此操作" }).click();
  await expect(
    dialog.getByRole("link", { name: "cloud-proof.txt", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await dialog.getByRole("button", { name: "在工作台继续会话" }).click();
  await expect(page.getByText(/容器执行验收通过/)).toHaveCount(2, {
    timeout: 45000,
  });
  await page.screenshot({
    path: evidence + "/flow-conversation.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    evidence + "/flow.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        ok: true,
        model: "isolated mock",
        checks: [
          "browser task creation",
          "remote execution selection",
          "approval before write",
          "container result download exact content",
          "restore and refresh remote conversation",
          "follow-up preserves workspace",
          "no browser runtime errors",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: browser create → remote container → approval → exact artifact download → restore/refresh → follow-up.",
  );
} finally {
  const id = page.url().match(/sessions\/(ses_[a-zA-Z0-9_]+)/)?.[1];
  if (id) {
    const session = await fetch(
      "http://127.0.0.1:8798/api/sessions/" + id,
    ).then((r) => r.json());
    if (session.status === "running")
      await fetch("http://127.0.0.1:8798/api/sessions/" + id + "/abort", {
        method: "POST",
      });
  }
  await browser.close();
}
