// Requires the isolated acceptance server and directory; uses no model requests.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const base = process.env.PIG_WORKBENCH_URL || "http://127.0.0.1:8798";
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const created = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let releaseCreate, releasePatch;
const createGate = new Promise((r) => {
  releaseCreate = r;
});
const patchGate = new Promise((r) => {
  releasePatch = r;
});
try {
  const response = await page.request.post(`${base}/api/sessions`, {
    data: {},
    headers: { Origin: base },
  });
  assert.equal(response.status(), 201);
  const original = await response.json();
  created.push(original.id);
  const fixturePath = resolve(
    resolve(
      process.env.PIG_TEST_DATA_DIR || "data/product-acceptance",
      "sessions",
    ),
    `${original.id}.json`,
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.id, original.id);
  fixture.executionTarget = "local";
  fixture.engine = "pig";
  fixture.title = "新建竞态：原任务";
  await writeFile(fixturePath, JSON.stringify(fixture));
  await page.goto(`${base}/#/sessions/${original.id}`);
  const picker = page.getByRole("combobox", { name: "执行位置", exact: true });
  await expect(picker).toBeEnabled();
  const patches = [];
  let nextId;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const result = await route.fetch();
    nextId = (await result.json()).id;
    created.push(nextId);
    await page.request.patch(`${base}/api/sessions/${nextId}`, {
      data: { executionTarget: "local", engine: "pig" },
      headers: { Origin: base },
    });
    await createGate;
    await route.fulfill({ response: result });
  });
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches.push(route.request().url().split("/").at(-1));
    const result = await route.fetch();
    await patchGate;
    await route.fulfill({ response: result });
  });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(
    page.getByText("正在创建新任务，请稍候…", { exact: true }),
  ).toBeVisible();
  await expect(picker).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "新对话", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  // Start selection immediately: Playwright must wait for the NEW task's control.
  const choice = picker.selectOption("remote");
  assert.deepEqual(patches, []);
  releaseCreate();
  await choice;
  await expect(
    page.getByText("正在保存执行配置，保存后即可发送…", { exact: true }),
  ).toBeVisible();
  await expect(picker).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  assert.deepEqual(patches, [nextId]);
  await page
    .locator('.session-sidebar button[title="新建竞态：原任务"]')
    .click();
  await expect(page).toHaveURL(new RegExp(original.id));
  releasePatch();
  await expect(
    page.getByText("正在保存执行配置，保存后即可发送…", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.session-sidebar button[aria-current="true"]'),
  ).toHaveAttribute("title", "新建竞态：原任务");
  await expect(picker).toHaveValue("local");
  const oldSaved = await (
    await page.request.get(`${base}/api/sessions/${original.id}`)
  ).json();
  const newSaved = await (
    await page.request.get(`${base}/api/sessions/${nextId}`)
  ).json();
  assert.notEqual(oldSaved.executionTarget, "remote");
  assert.equal(newSaved.executionTarget, "remote");
  assert.deepEqual(errors, []);
  console.log(
    "PASS creation blocks old controls and duplicate creation; immediate selection PATCHes new task only; pending execution settings block send; stale PATCH response cannot replace selected task.",
  );
} finally {
  releaseCreate();
  releasePatch();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const id of created)
    await page.request
      .delete(`${base}/api/sessions/${id}`, { headers: { Origin: base } })
      .catch(() => {});
  await browser.close();
}
