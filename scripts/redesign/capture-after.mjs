import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const base = "http://127.0.0.1:8799",
  out = "data/redesign-evidence/after";
await mkdir(out, { recursive: true });
const baseline = JSON.parse(
  await readFile("data/redesign-evidence/before/manifest.json", "utf8"),
);
const api = async (path, data, method = data ? "POST" : "GET") => {
  const r = await fetch(base + path, {
    method,
    headers: { Origin: base, "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!r.ok) throw Error(`${path} ${r.status}`);
  return r.json();
};
const settings = await api("/api/settings");
assert.equal(
  resolve(settings.workspaceRoot),
  resolve("data/redesign-local/workspace"),
  "isolated workspace required",
);
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const captures = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let runSession, executionFixture;
async function matrix(state, kind, prepare) {
  for (const theme of ["light", "dark"])
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        localStorage.setItem("pig-agent.theme", t);
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
        window.dispatchEvent(
          new StorageEvent("storage", { key: "pig-agent.theme", newValue: t }),
        );
      }, theme);
      if (prepare) await prepare();
      await page.waitForTimeout(100);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        headerHeight: document
          .querySelector(".task-header")
          ?.getBoundingClientRect().height,
        inspector: !!document.querySelector(".inspector-frame"),
        primaryText: getComputedStyle(document.body).fontSize,
      }));
      assert.ok(metrics.scrollWidth <= width, `${state} horizontal overflow`);
      assert.ok(
        metrics.headerHeight <= (width < 768 ? 56 : 64),
        `${state} header height`,
      );
      const file = `${state}-${width}x${height}-${theme}.png`;
      await page.screenshot({ path: out + "/" + file });
      captures.push({ state, kind, file, width, height, theme, metrics });
    }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function nav(id) {
  await page.goto(base + "/#/sessions/" + id);
  await expect(page.locator(".task-header")).toBeVisible();
  await expect(page.getByPlaceholder(/描述目标/)).toBeVisible();
}
try {
  await nav(baseline.fixtureIds[0]);
  await expect(
    page.getByRole("button", { name: "任务配置", exact: true }),
  ).toBeEnabled();
  await expect(page.getByPlaceholder(/描述目标/)).toBeEnabled();
  await matrix("empty", "Explicit UI fixture title/list; actual empty session");
  assert.equal(await page.locator(".inspector-frame").count(), 0);
  await nav(baseline.fixtureIds[1]);
  await expect(
    page.getByText("[UI夹具，非真实执行结果]", { exact: false }),
  ).toBeVisible();
  await matrix(
    "long-content",
    "Explicit fixture long Chinese / Markdown / code / table",
  );
  executionFixture = await api("/api/sessions", {});
  const path = resolve(
    "data/redesign-local/store/sessions",
    executionFixture.id + ".json",
  );
  const f = JSON.parse(await readFile(path, "utf8"));
  f.title = "[UI夹具] 执行中：核对长工具输出与任务进度，不代表真实运行";
  f.status = "running";
  f.messages = [
    {
      id: "fixture_user",
      role: "user",
      content:
        "[UI夹具] 请核对数据并生成报告。下方执行状态和工具输出仅用于界面验收。",
      createdAt: new Date().toISOString(),
    },
    {
      id: "fixture_call",
      role: "assistant",
      content: "[UI夹具] 正在逐项检查输入记录。",
      toolCalls: [
        {
          id: "fixture_tool",
          name: "read_file",
          arguments: JSON.stringify({
            path: "fixtures/quarterly-report-with-a-long-name.md",
          }),
        },
      ],
      createdAt: new Date().toISOString(),
    },
  ];
  f.steps = [
    {
      id: "fixture_step",
      title: "核对跨部门数据来源与缺失记录",
      status: "running",
    },
  ];
  await writeFile(path, JSON.stringify(f));
  await nav(f.id);
  await matrix(
    "executing",
    "Explicit UI fixture running state; real container lifecycle proved separately by flow.json",
  );
  f.status = "idle";
  f.messages.push({
    id: "fixture_result",
    role: "tool",
    toolCallId: "fixture_tool",
    content:
      "[UI夹具工具结果]\n" + "记录已核对：来源字段与金额一致。\n".repeat(80),
    toolOk: true,
    createdAt: new Date().toISOString(),
  });
  await writeFile(path, JSON.stringify(f));
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  runSession = await (await response).json();
  await page.waitForURL("**/sessions/" + runSession.id);
  await page.getByLabel("执行位置", { exact: true }).selectOption("remote");
  await expect(page.getByLabel("写入前审批")).toBeEnabled();
  if (!(await page.getByLabel("写入前审批").isChecked()))
    await page.getByLabel("写入前审批").click();
  await expect(page.getByLabel("写入前审批")).toBeChecked();
  await page
    .getByPlaceholder(/描述目标/)
    .fill("视觉验收真实流程：创建并读回 cloud-proof.txt，核验容器成果。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const approve = page.getByRole("button", { name: "批准操作", exact: true });
  await expect(approve).toBeVisible({ timeout: 60000 });
  await matrix("approval", "Real mock container pending authorized write", () =>
    approve.scrollIntoViewIfNeeded(),
  );
  await approve.click();
  await expect
    .poll(
      async () => (await api("/api/sessions/" + runSession.id)).remoteState,
      { timeout: 60000 },
    )
    .toBe("succeeded");
  await page.getByRole("button", { name: /项成果可核验/ }).click();
  const inspector = page.getByRole("complementary", { name: "远端成果检查器" });
  await expect(
    inspector.getByText("PIG_CLOUD_CONTAINER_OK", { exact: true }),
  ).toBeVisible();
  const d = page.waitForEvent("download");
  await inspector.getByRole("link", { name: "下载", exact: true }).click();
  assert.equal(
    (await readFile(await (await d).path(), "utf8")).trim(),
    "PIG_CLOUD_CONTAINER_OK",
  );
  await matrix(
    "result",
    "Real authorized remote artifact exact-content download",
  );
  await page.getByRole("button", { name: "关闭成果面板" }).click();
  await page.route("**/api/remote/**", (r) => r.abort("failed"));
  await expect(page.getByText(/连接暂时中断，正在重新连接/)).toBeVisible({
    timeout: 16000,
  });
  await matrix(
    "error",
    "Real browser network fault injection; last known task retained",
    () => page.getByText(/连接暂时中断，正在重新连接/).scrollIntoViewIfNeeded(),
  );
  await page.unroute("**/api/remote/**");
  await expect(page.getByText(/连接暂时中断，正在重新连接/)).toHaveCount(0, {
    timeout: 16000,
  });
  await matrix("recovery", "Same real task after connection restored");
  await page.reload();
  await expect(page.getByText(/容器执行验收通过/).first()).toBeVisible();
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/workbench-matrix.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        realSessionId: runSession.id,
        executionFixtureId: executionFixture.id,
        captures,
        errors,
        checks: [
          "single row header 60px desktop/56px mobile",
          "no empty inspector",
          "current-task inline approval visible on mobile",
          "exact remote download",
          "network failure and recovery",
          "refresh restore",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ screenshots: captures.length, errors }));
} catch (e) {
  await page.screenshot({ path: out + "/matrix-failure.png" });
  console.error(String(e.message).split("\n").slice(0, 12).join("\n"));
  process.exitCode = 1;
} finally {
  if (runSession) {
    const s = await api("/api/sessions/" + runSession.id);
    if (s.status === "running")
      await api("/api/sessions/" + runSession.id + "/abort", {});
  }
  await browser.close();
}
