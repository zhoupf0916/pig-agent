import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.PIG_PLUGIN_UI_BASE || "http://127.0.0.1:8799";
const out = "data/plugin-ui-evidence";
await mkdir(out, { recursive: true });
const api = async (path) => {
  const r = await fetch(base + path);
  if (!r.ok) throw Error(path);
  return r.json();
};
assert.equal(
  (await api("/api/plugins")).plugins.length,
  0,
  "requires isolated empty plugin store",
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
async function open() {
  await page.goto(base);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /^插件/ }).click();
  await expect(page.getByRole("region", { name: "插件管理" })).toBeVisible();
}
try {
  await open();
  const panel = page.getByRole("region", { name: "插件管理" });
  await panel
    .locator("input[type=file]")
    .setInputFiles("docs/examples/writing.plugin.json");
  await expect(page.getByRole("region", { name: "插件预览" })).toBeVisible();
  await page.getByText("检查 1 个专家、1 个技能").click();
  await expect(page.getByRole("region", { name: "插件预览" })).toContainText(
    "不能编造引用",
  );
  await page.screenshot({ path: out + "/preview-desktop.png" });
  await page.getByRole("button", { name: "导入，暂不启用" }).click();
  await expect(panel).toContainText("插件已导入，尚未启用");
  assert.equal((await api("/api/plugins")).plugins[0].enabled, false);
  assert.ok(
    !(await api("/api/experts")).experts.some((e) =>
      e.id.startsWith("plugin_"),
    ),
  );
  assert.ok(
    !(await api("/api/skills")).skills.some((e) =>
      e.name.startsWith("plugin_"),
    ),
  );
  checks.push(
    "import preview shows instructions; installed disabled and no skill/expert contribution",
  );
  await panel.getByRole("button", { name: "启用", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "停用", exact: true }),
  ).toBeVisible();
  assert.ok(
    (await api("/api/experts")).experts.some(
      (e) => e.id === "plugin_clear-writing_editor",
    ),
  );
  assert.ok(
    (await api("/api/skills")).skills.some(
      (e) => e.name === "plugin_clear-writing_edit-copy",
    ),
  );
  await expect(
    panel.getByRole("button", { name: "移除", exact: true }),
  ).toBeDisabled();
  await open();
  await expect(
    page.getByRole("button", { name: "停用", exact: true }),
  ).toBeVisible();
  checks.push(
    "enable contributes actual expert/skill; reload preserves enabled state; remove disabled while enabled",
  );
  await page.screenshot({ path: out + "/installed-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + "/installed-mobile.png" });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await panel.getByRole("button", { name: "停用", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "启用", exact: true }),
  ).toBeVisible();
  assert.ok(
    !(await api("/api/experts")).experts.some(
      (e) => e.id === "plugin_clear-writing_editor",
    ),
  );
  assert.ok(
    !(await api("/api/skills")).skills.some(
      (e) => e.name === "plugin_clear-writing_edit-copy",
    ),
  );
  await panel.getByRole("button", { name: "移除", exact: true }).click();
  await expect(panel).toContainText("还没有插件");
  assert.equal((await api("/api/plugins")).plugins.length, 0);
  checks.push(
    "disable removes contributions; remove persists empty store; mobile has no horizontal overflow",
  );
  await panel
    .locator("input[type=file]")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"format":"script"}'),
    });
  await expect(panel.getByRole("alert")).toContainText("插件格式无效");
  checks.push("invalid package displays actionable failure");
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/report.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
