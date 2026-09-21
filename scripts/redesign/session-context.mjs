// Isolated metadata fixtures + real requests with delayed responses. No model or tool execution.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const base = process.env.PIG_WORKBENCH_URL || "http://127.0.0.1:8799";
assert(
  ["http://127.0.0.1:8799", "http://127.0.0.1:8798"].includes(base),
  "isolated acceptance service required",
);
const data = resolve(
  process.env.PIG_TEST_DATA_DIR || "data/redesign-local/store",
);
const out = "data/redesign-evidence/after";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fixtures = [],
  checks = [],
  errors = [];
let projectId;
const releases = [];
page.on("pageerror", (e) => errors.push(e.message));
async function api(path, method = "GET", body) {
  const r = await page.request.fetch(base + path, {
    method,
    headers: { Origin: base },
    data: body,
  });
  assert(r.ok(), path + " " + r.status());
  return r.json();
}
async function fixture(title, status = "idle") {
  const result = await api("/api/sessions", "POST", {});
  fixtures.push(result.id);
  const path = resolve(data, "sessions", result.id + ".json");
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    record.id,
    result.id,
    "fixture directory must belong to this service",
  );
  Object.assign(record, {
    title,
    status,
    executionTarget: "local",
    engine: "pig",
    messages: [
      {
        id: "msg_context_fixture",
        role: "user",
        content: "明确标记的 UI 时序夹具；不调用模型，不执行工具。",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  await writeFile(path, JSON.stringify(record));
  return record;
}
async function select(session) {
  await page
    .locator(".session-sidebar")
    .getByRole("button", { name: new RegExp(session.title) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(session.id));
  await expect(page.locator(".task-heading h1")).toHaveText(session.title);
}
function gate() {
  let release, seen;
  const wait = new Promise((r) => (release = r)),
    hit = new Promise((r) => (seen = r));
  releases.push(release);
  return { wait, hit, release, seen };
}
try {
  const a = await fixture("UI时序夹具 A " + Date.now(), "running"),
    b = await fixture("UI时序夹具 B " + Date.now());
  await page.goto(base + "/#/sessions/" + a.id);
  const cancel = gate();
  await page.route(`**/api/sessions/${a.id}/team-run`, async (route) => {
    const response = await route.fetch();
    cancel.seen();
    await cancel.wait;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await cancel.hit;
  await select(b);
  cancel.release();
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(new RegExp(b.id));
  await expect(page.locator(".task-heading h1")).toHaveText(b.title);
  checks.push("delayed real cancel response cannot reopen previous task");
  await page.unroute(`**/api/sessions/${a.id}/team-run`);
  projectId = (
    await api("/api/projects", "POST", {
      name: "UI context race fixture " + Date.now(),
    })
  ).id;
  await page.reload();
  await select(a);
  await page.getByRole("button", { name: "任务配置", exact: true }).click();
  const binding = gate();
  await page.route(`**/api/sessions/${a.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    binding.seen();
    await binding.wait;
    await route.fulfill({ response });
  });
  await page
    .getByRole("combobox", { name: "项目", exact: true })
    .selectOption(projectId);
  await binding.hit;
  await select(b);
  binding.release();
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(new RegExp(b.id));
  await expect(page.locator(".task-heading h1")).toHaveText(b.title);
  assert.equal((await api("/api/sessions/" + a.id)).projectId, projectId);
  assert.notEqual((await api("/api/sessions/" + b.id)).projectId, projectId);
  checks.push(
    "delayed actual project binding updates A only and never replaces visible B",
  );
  await page.unroute(`**/api/sessions/${a.id}`);
  await select(a);
  await page
    .locator(".composer-box textarea")
    .fill("UI 时序草稿，不发送模型请求");
  const loading = gate();
  await page.route(`**/api/sessions/${b.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    loading.seen();
    await loading.wait;
    await route.fulfill({ response });
  });
  await page
    .locator(".session-sidebar")
    .getByRole("button", { name: new RegExp(b.title) })
    .first()
    .click();
  await loading.hit;
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "执行位置", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "任务配置", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "执行位置", exact: true }),
  ).toBeDisabled();
  loading.release();
  await expect(page.locator(".task-heading h1")).toHaveText(b.title);
  await page.unroute(`**/api/sessions/${b.id}`);
  checks.push(
    "delayed task detail GET disables old-task send and execution configuration until B loads",
  );

  // Explicit UI transport fixture: hold the message request BEFORE forwarding it.
  // This tests browser ownership only and never invokes a model or backend turn.
  await select(a);
  const stream = gate();
  await page.route(`**/api/sessions/${a.id}/messages`, async (route) => {
    stream.seen();
    await stream.wait;
    await route
      .fulfill({ status: 200, contentType: "text/event-stream", body: "" })
      .catch(() => {});
  });
  await page
    .locator(".composer-box textarea")
    .fill("明确标记的 UI 流式传输夹具，不调用模型");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await stream.hit;
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await select(b);
  await page.locator(".composer-box textarea").fill("B 草稿，仅验证可以编辑");
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await select(a);
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  const aborted = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.url().endsWith(`/api/sessions/${a.id}/messages`),
  });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await aborted;
  stream.release();
  await page.unroute(`**/api/sessions/${a.id}/messages`);
  await select(b);
  checks.push(
    "explicit pending-message transport fixture: A streaming does not give B a stop button or block B composer; stopping A aborts A request only",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "文件与产物", exact: true }).click();
  const drawer = page.getByRole("dialog", {
    name: "任务成果检查器",
    exact: true,
  });
  await expect(drawer).toBeVisible();
  assert(
    await drawer.evaluate((el) => el.contains(document.activeElement)),
    "opening inspector focuses drawer",
  );
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    assert(
      await drawer.evaluate((el) => el.contains(document.activeElement)),
      "Tab cannot escape drawer",
    );
  }
  await page.screenshot({ path: out + "/inspector-focus-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "文件与产物", exact: true }),
  ).toBeFocused();
  checks.push(
    "mobile inspector moves focus, contains keyboard traversal, Escape closes and restores opener",
  );
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const nav = page.getByRole("complementary", { name: "全局导航" });
  assert(
    await nav.evaluate((el) => el.contains(document.activeElement)),
    "navigation opens with focus inside",
  );
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    assert(
      await nav.evaluate((el) => el.contains(document.activeElement)),
      "Tab cannot escape navigation",
    );
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "打开导航", exact: true }),
  ).toBeFocused();
  checks.push(
    "mobile navigation contains focus and restores trigger on Escape",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/session-context.json",
    JSON.stringify({ at: new Date().toISOString(), checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  await page.screenshot({ path: out + "/session-context-failure.png" });
  throw error;
} finally {
  for (const release of releases) release();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const id of fixtures)
    await api("/api/sessions/" + id, "DELETE").catch(() => {});
  if (projectId)
    await api("/api/projects/" + projectId, "DELETE").catch(() => {});
  await browser.close();
}
