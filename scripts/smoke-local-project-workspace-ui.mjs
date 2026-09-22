import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
const base = "http://127.0.0.1:8799",
  out = "data/project-ui-evidence";
await mkdir(out, { recursive: true });
const secrets = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
await fetch(base + "/api/settings", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    cloudMode: "remote",
    cloudBaseUrl: "http://127.0.0.1:8892",
    cloudToken: secrets.MEMBER_TOKEN,
  }),
});
const projectName = "普通项目工作区 " + Date.now();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "项目分支" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /项目目录/ }).click();
  await page.getByPlaceholder("新项目名称").fill(projectName);
  await page
    .getByRole("dialog", { name: "项目目录" })
    .getByRole("button", { name: "新建项目", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: projectName, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "项目工作区" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "项目工作区" })
      .getByRole("textbox", { name: "项目目录", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("region", { name: "项目工作区" })
    .getByRole("textbox", { name: "项目目录", exact: true })
    .fill(resolve("data/project-ui-local-root"));
  await page.getByRole("button", { name: "保存工作区", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("工作区已保存");
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "项目工作区" })
      .getByRole("textbox", { name: "项目目录", exact: true }),
  ).toHaveValue(resolve("data/project-ui-local-root"));
  await page.screenshot({ path: out + "/local-workspace-desktop.png" });
  await page
    .getByRole("button", { name: "在此项目开任务", exact: true })
    .click();
  await expect(page).toHaveURL(/sessions/);
  const sid = page.url().split("/").at(-1);
  const response = await fetch(base + "/api/sessions/" + sid);
  const session = await response.json();
  assert.equal(session.workspaceRoot, resolve("data/project-ui-local-root"));
  await page.getByRole("button", { name: "文件与产物", exact: true }).click();
  await page.getByRole("button", { name: "本机工作区", exact: true }).click();
  await expect(
    page.getByText("PROJECT_ONLY.txt", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("GLOBAL_ONLY.txt", { exact: true })).toHaveCount(
    0,
  );
  await page.getByText("PROJECT_ONLY.txt", { exact: true }).click();
  await expect(
    page.getByText("PROJECT_SCOPED_CONTENT", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: out + "/local-project-file-desktop.png" });
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "项目协同", exact: true }).click();
  await expect(page.locator(".cw-embedded")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "项目分支" }),
  ).toBeVisible();
  assert.ok(page.url().includes("/projects/collaboration"));
  await expect(
    page
      .locator(".cw-embedded")
      .getByRole("button", { name: "新建协同任务", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: out + "/embedded-collaboration-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + "/embedded-collaboration-mobile.png" });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/local-report.json",
    JSON.stringify(
      {
        sessionId: sid,
        checks: [
          "local project directory saves and persists refresh",
          "new session inherits actual project directory",
          "file tree and file preview use session workspace; global file absent",
          "project collaboration stays inside App project navigation",
          "mobile no horizontal overflow",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
