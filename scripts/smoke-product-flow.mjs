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
let streamingEvidence;
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
  await page.getByRole("button", { name: "新对话", exact: true }).click();
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
  await page.evaluate(() => {
    window.__streamSamples = [];
    window.__streamObserver = new MutationObserver(() => {
      const text =
        document.querySelector('[data-streaming="true"]')?.textContent || "";
      const list = window.__streamSamples;
      if (text && text !== list.at(-1)?.text)
        list.push({ text, at: performance.now() });
    });
    window.__streamObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  const firstApproval = approve();
  await page.locator('[data-streaming="true"]').waitFor();
  await page.screenshot({ path: evidence + "/flow-streaming.png" });
  await firstApproval;
  const samples = await page.evaluate(() => {
    window.__streamObserver.disconnect();
    return window.__streamSamples;
  });
  assert(
    samples.length >= 2,
    "real container reply must paint multiple incremental text fragments before completion",
  );
  const expectedText =
    "容器执行验收通过：已创建并读回 cloud-proof.txt。当前为模拟模型模式，尚未调用真实提供商。";
  assert(
    samples.every((sample) => expectedText.startsWith(sample.text)),
    "stream must remain an exact prefix, without duplicated tokens from two SSE connections",
  );
  await expect(page.getByText(expectedText, { exact: true })).toHaveCount(1);
  const recorded = await fetch(
    `${base}/api/sessions/${sessionId}/events?live=0&after=0`,
  ).then((r) => r.json());
  const tokens = recorded.events.filter((row) => row.event.type === "token");
  assert(tokens.length >= 2);
  assert.equal(tokens.map((row) => row.event.text).join(""), expectedText);
  const cursor = tokens[0].seq;
  const resumed = await fetch(
    `${base}/api/sessions/${sessionId}/events?live=0&after=${cursor}`,
  ).then((r) => r.json());
  assert(resumed.events.every((row) => row.seq > cursor));
  assert.equal(
    tokens[0].event.text +
      resumed.events
        .filter((row) => row.event.type === "token")
        .map((row) => row.event.text)
        .join(""),
    expectedText,
  );
  const runId = (await session()).remoteRunId;
  const remoteLog = await fetch(
    `${base}/api/remote/v1/runs/${runId}/eventlog`,
  ).then((r) => r.json());
  const remoteTokens = remoteLog.events.filter(
    (row) => row.event.type === "token",
  );
  assert(remoteTokens.length >= 2);
  const resumedSse = await fetch(
    `${base}/api/remote/v1/runs/${runId}/events?after=${remoteTokens[0].seq}`,
  ).then((r) => r.text());
  const replayed = resumedSse
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((event) => event.type === "token");
  assert.equal(
    remoteTokens[0].event.text + replayed.map((event) => event.text).join(""),
    expectedText,
    "control-plane SSE reconnect resumes exact suffix",
  );
  streamingEvidence = {
    visualUpdates: samples.length,
    tokenEvents: tokens.length,
    visibleOutputSpanMs: Math.round(samples.at(-1).at - samples[0].at),
    exactPrefixes: true,
    cursorReplayExact: true,
  };
  await page.screenshot({ path: evidence + "/flow-streamed.png" });
  checks.push(
    "real container paints progressive exact text; dual SSE delivery and cursor replay do not duplicate tokens",
  );
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
  // Explicit retry starts a new remote conversation. Build two real successful
  // versions in that current conversation for the subsequent provenance check.
  const recoveredRun = (await session()).remoteRunId;
  await send("继续核验重试后的 cloud-proof.txt，保留第二个可下载版本。");
  await approve();
  assert.notEqual((await session()).remoteRunId, recoveredRun);
  checks.push(
    "follow-up after explicit retry creates a second successful version in the recovered conversation",
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
        streamingEvidence,
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
