// Read-only remote runs, isolated local metadata fixture. No model calls.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8798";
const browser = await chromium.launch({ channel: process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
let fixtureId;
try {
  const remote = await (
    await page.request.get(`${base}/api/remote/v1/runs`)
  ).json();
  assert.ok(
    remote.runs.length >= 2,
    "Requires at least two remote runs in the isolated acceptance platform",
  );
  const [current, prior] = remote.runs;
  const result = await page.request.post(`${base}/api/sessions`, {
    data: {},
    headers: { Origin: base },
  });
  assert.equal(result.status(), 201);
  const fixture = await result.json();
  fixtureId = fixture.id;
  const file = resolve("data/product-acceptance/sessions", `${fixtureId}.json`);
  assert.equal(JSON.parse(await readFile(file, "utf8")).id, fixtureId);
  fixture.title = "远端入口跟随验收夹具";
  fixture.executionTarget = "remote";
  fixture.remoteRunId = prior.id;
  await writeFile(file, JSON.stringify(fixture));
  await page.goto(`${base}/#/sessions/${fixtureId}`);
  await expect(page.locator('[data-runtime-kind="cloud-remote"]')).toBeVisible();
  await expect(page.getByText("远端容器 · 控制面调度", {exact:true})).toBeVisible();
  await expect(page.getByText(/请在全局设置切换运行时/)).toHaveCount(0);
  await page.getByRole("button", {name:"查看远端运行与审批",exact:true}).click();
  const dialog = page.getByRole("dialog", { name: "远端运行记录" });
  await expect(dialog.locator("article code").first()).toHaveText(prior.id);
  // Simulate the existing server's onRunCreated persisted-ID transition while
  // the workbench still holds the prior ID; all displayed run details are real.
  fixture.remoteRunId = current.id;
  await writeFile(file, JSON.stringify(fixture));
  await expect(dialog.locator("article code").first()).toHaveText(current.id, {
    timeout: 10000,
  });
  await dialog.locator("aside button").nth(1).click();
  await expect(dialog.locator("article code").first()).toHaveText(prior.id);
  await expect(
    dialog.getByRole("button", { name: "回到当前会话", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(4500); // Two polling windows must not steal manual selection.
  await expect(dialog.locator("article code").first()).toHaveText(prior.id);
  await dialog
    .getByRole("button", { name: "回到当前会话", exact: true })
    .click();
  await expect(dialog.locator("article code").first()).toHaveText(current.id);
  console.log(
    "PASS persisted active run ID follows while modal is open; manual history selection survives polling; explicit return resumes following.",
  );
} finally {
  if (fixtureId)
    await page.request
      .delete(`${base}/api/sessions/${fixtureId}`, {
        headers: { Origin: base },
      })
      .catch(() => {});
  await browser.close();
}
