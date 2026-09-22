import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:8799",
  out = "data/redesign-evidence/prototype";
await mkdir(out, { recursive: true });
const before = JSON.parse(
  await readFile("data/redesign-evidence/before/manifest.json", "utf8"),
);
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
async function shot(state) {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await p.setViewportSize({ width, height });
    await p.screenshot({ path: `${out}/${state}-${width}.png` });
  }
  await p.setViewportSize({ width: 1440, height: 900 });
}
try {
  await p.goto(base + "/#/sessions/" + before.fixtureIds[0]);
  await p.getByText("交代一个任务，在这台电脑或云端沙箱里做完，你来批准和核对。").waitFor();
  await shot("empty");
  await p.getByRole("button", { name: "设置", exact: true }).click();
  await p.getByRole("dialog", { name: "设置" }).waitFor();
  await shot("settings");
  await p.keyboard.press("Escape");
  const response = p.waitForResponse(
    (r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST",
  );
  await p.getByRole("button", { name: "新对话", exact: true }).click();
  const session = await (await response).json();
  await p.waitForURL("**/sessions/" + session.id);
  await expect(p.getByRole("heading", { name: "新会话", exact: true }))
    .toHaveCount(0)
    .catch(() => {});
  await p.getByLabel("执行位置", { exact: true }).selectOption("remote");
  await expect(p.getByLabel("写入前审批", { exact: true })).toBeVisible();
  if (!(await p.getByLabel("写入前审批").isChecked())) {
    await p.getByLabel("写入前审批").click();
    await expect(p.getByLabel("写入前审批")).toBeChecked();
  }
  await p
    .getByPlaceholder(/描述目标/)
    .fill("重设计样板：创建 cloud-proof.txt 并读回，核验成果。");
  await p.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    p.getByRole("button", { name: "批准操作", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await shot("approval");
  await p.getByRole("button", { name: "批准操作", exact: true }).click();
  await expect(p.getByRole("button", { name: /项成果可核验/ })).toBeVisible({
    timeout: 60000,
  });
  await p.getByRole("button", { name: /项成果可核验/ }).click();
  await expect(
    p.getByRole("complementary", { name: "远端成果检查器" }),
  ).toBeVisible();
  await shot("result");
  await writeFile(
    out + "/result.json",
    JSON.stringify({ sessionId: session.id, errors }, null, 2),
  );
  console.log("Prototype real flow/screenshots complete");
} finally {
  await b.close();
}
