import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
const base = process.env.PIG_ADMIN_BASE || "http://127.0.0.1:8896";
const dir = "data/redesign-evidence/admin";
await mkdir(dir, { recursive: true });
await mkdir("data/redesign-evidence/after", { recursive: true });
const { ADMIN_TOKEN } = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const evidence = {
  base,
  api: "real isolated cluster8892",
  screenshots: [],
  checks: [],
};
try {
  await page.goto(base + "/admin/");
  await page.getByLabel("管理员令牌").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "连接平台", exact: true }).click();
  await expect(page.locator("#dashboard")).toBeVisible();
  const sizes = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        localStorage.setItem("pig.admin.theme", value);
        location.reload();
      }, theme);
      await expect(page.locator("#dashboard")).toBeVisible();
      for (const route of [
        "overview",
        "runs",
        "workers",
        "settings",
        "accounts",
        "audit",
      ]) {
        await page.goto(base + "/admin/#" + route);
        await expect(page.locator(`[data-view="${route}"]`)).toBeVisible();
        const file = `${route}-${size.width}x${size.height}-${theme}.png`;
        await page.screenshot({ path: dir + "/" + file });
        evidence.screenshots.push(file);
        await copyFile(
          dir + "/" + file,
          `data/redesign-evidence/after/admin-${route === "workers" ? "runners" : route}-${size.width}x${size.height}-${theme}.png`,
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "horizontal page overflow " + file,
        );
        assert.ok(
          (await page
            .locator(".workspace>header")
            .evaluate((e) => e.getBoundingClientRect().height)) <= 60,
          "header too high " + file,
        );
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "/admin/#workers");
  const before = await page.locator(".worker-row").count();
  assert.ok(before >= 2, "two real online runners");
  await page
    .getByRole("combobox", { name: "筛选 Runner 状态" })
    .selectOption("offline");
  if (await page.locator(".worker-row").count())
    await expect(page.locator(".worker-row").first()).toContainText("离线");
  await page
    .getByRole("combobox", { name: "筛选 Runner 状态" })
    .selectOption("online");
  await page
    .getByRole("searchbox", { name: "搜索 Runner" })
    .fill("pig-cluster-runner-a");
  await expect(page.locator(".worker-row")).toHaveCount(1);
  await page.locator(".worker-row summary").click();
  await expect(page.getByLabel("pig-cluster-runner-a 并发槽位")).toBeVisible();
  evidence.checks.push(
    "Runner defaultonline, historicaloffline, search and compactdetails operate on realnodes",
  );
  await page.goto(base + "/admin/#runs");
  await page
    .getByRole("combobox", { name: "筛选任务状态" })
    .selectOption("succeeded");
  await page
    .locator("#runs")
    .getByRole("button", { name: "详情与日志" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".detail-artifacts")).toBeVisible();
  const download = page
    .locator(".detail-artifacts")
    .getByRole("button", { name: "下载成果" })
    .first();
  if (await download.count()) {
    await page
      .locator(".detail-artifacts")
      .getByRole("button", { name: "预览", exact: true })
      .first()
      .click();
    await expect(page.locator(".artifact-preview").first()).toBeVisible();
    const p = page.waitForEvent("download");
    await download.click();
    const d = await p;
    const bytes = await readFile(await d.path());
    assert.ok(bytes.length > 0);
    evidence.checks.push(
      "Adminauthorizedremoteartifactpreview/download " +
        bytes.length +
        " bytes",
    );
  } else throw Error("Need successfulrealrunwithartifact foradmincheck");
  await page.screenshot({ path: dir + "/run-detail-artifact-desktop.png" });
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(()=>page.locator("#admin-sidebar").evaluate(el=>el.inert)).toBe(true);
  await page.getByRole("button", { name: "打开管理导航" }).click();
  await expect(page.locator("#navigation")).toBeVisible();
  assert.equal(await page.locator(".workspace").evaluate(el=>el.inert),true);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "打开管理导航" }),
  ).toBeFocused();
  assert.equal(await page.locator("#admin-sidebar").evaluate(el=>el.inert),true);
  await page.getByRole("button", { name: "打开管理导航" }).click();
  await page.getByRole("link",{name:"任务与日志",exact:true}).click();
  await expect(page.getByRole("button",{name:"打开管理导航"})).toHaveAttribute("aria-expanded","false");
  assert.equal(await page.locator(".workspace").evaluate(el=>el.inert),false);
  evidence.checks.push(
    "Mobile drawer keyboardclose restoresfocus; no horizontalpageoverflow at3sizes",
  );
  assert.deepEqual(errors, []);
  evidence.errors = errors;
  await writeFile(dir + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      screenshots: evidence.screenshots.length,
      checks: evidence.checks,
      errors,
    }),
  );
} finally {
  await browser.close();
}
