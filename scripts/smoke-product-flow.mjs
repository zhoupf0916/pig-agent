import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const evidence = process.env.PIG_FLOW_EVIDENCE || "data/product-evidence";
const base = process.env.PIG_FLOW_BASE || "http://127.0.0.1:8798";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
let sessionId;
const session = () =>
  fetch(`${base}/api/sessions/${sessionId}`).then((r) => r.json());
async function send(text) {
  await page.getByPlaceholder(/描述目标/).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
}
async function approve() {
  await page.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect
    .poll(async () => (await session()).remoteState, { timeout: 60000 })
    .toBe("succeeded");
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0, { timeout: 15000 });
}
try {
  await page.goto(base);
  const createdResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  sessionId = (await (await createdResponse).json()).id;
  await page.waitForURL("**/#/sessions/" + sessionId);
  await page.getByLabel("执行位置", { exact: true }).selectOption("remote");
  await expect(page.getByLabel("写入前审批")).toBeEnabled();
  if (!(await page.getByLabel("写入前审批").isChecked()))
    await page.getByLabel("写入前审批").click();
  await expect(page.getByLabel("写入前审批")).toBeChecked();
  await send("产品验收：请创建并读回 cloud-proof.txt，核验容器执行成果。");
  await page.screenshot({ path: evidence + "/flow-approval.png" });
  checks.push(
    "real browser creation and inline remote approval without leaving task",
  );
  await approve();
  await page.getByRole("button", { name: /项成果可核验/ }).click();
  const inspector = page.getByRole("complementary", { name: "远端成果检查器" });
  const downloadPromise = page.waitForEvent("download");
  await inspector.getByRole("link", { name: "下载", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(
    (await readFile(await download.path(), "utf8")).trim(),
    "PIG_CLOUD_CONTAINER_OK",
  );
  checks.push(
    "authorized remote artifact download matches exact container content",
  );
  await page.screenshot({ path: evidence + "/flow-result.png" });
  await page.getByRole("button", { name: "关闭成果面板" }).click();
  await page.reload();
  await expect(page.getByText(/容器执行验收通过/).first()).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "任务配置", exact: true }).click();
  await expect(page.getByLabel("执行位置")).toHaveValue("remote");
  await page.getByRole("button", { name: "任务配置", exact: true }).click();
  checks.push("reload preserves remote task identity and conversation");
  const first = (await session()).remoteRunId;
  await send("继续核验刚才的文件，报告已保存的结果。");
  await approve();
  assert.notEqual((await session()).remoteRunId, first);
  await expect(page.getByText(/容器执行验收通过/)).toHaveCount(2, {
    timeout: 15000,
  });
  checks.push(
    "follow-up uses next run automatically and preserves remote workspace",
  );
  await page.screenshot({ path: evidence + "/flow-conversation.png" });
  await send("再次核验 cloud-proof.txt。此轮用于拒绝审批后恢复测试。");
  await page
    .getByRole("button", { name: "拒绝并结束本轮", exact: true })
    .click();
  await expect
    .poll(async () => (await session()).remoteState, { timeout: 60000 })
    .toBe("failed");
  const retry = page.getByRole("button", { name: /^重试/ }).first();
  await expect(retry).toBeEnabled({ timeout: 15000 });
  await retry.click();
  await expect(
    page.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await approve();
  checks.push(
    "rejected operation fails explicitly; user-triggered retry returns to approval and succeeds",
  );
  await send("再次检查文件，此轮用于验证取消。");
  const cancelledRun = (await session()).remoteRunId;
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect
    .poll(
      async () => {
        const r = await fetch(`${base}/api/remote/v1/runs/${cancelledRun}`);
        return (await r.json()).state;
      },
      { timeout: 45000 },
    )
    .toBe("cancelled");
  checks.push("cancel from current task reaches confirmed cancelled state");
  assert.deepEqual(errors, []);
  checks.push("no browser runtime errors");
  await writeFile(
    evidence + "/flow.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        ok: true,
        model: "isolated mock",
        sessionId,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: browser create / inline approval / exact artifact / reload / follow-up / reject / retry / cancel.",
  );
} finally {
  if (sessionId) {
    const s = await session().catch(() => null);
    if (s?.status === "running")
      await fetch(`${base}/api/sessions/${sessionId}/abort`, {
        method: "POST",
        headers: { Origin: base },
      }).catch(() => {});
  }
  await browser.close();
}
