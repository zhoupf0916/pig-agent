import { _electron, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const out = "data/project-ui-evidence";
await mkdir(out, { recursive: true });
const userdata = resolve("data/project-electron-review-" + Date.now());
const secrets = parseEnv(
  await readFile("data/cluster-local/stack.env", "utf8"),
);
const base = "http://127.0.0.1:8892";
const account = {
  username: "nativeui" + Date.now(),
  password: "Native-acceptance-" + Date.now(),
  name: "桌面协作验收",
};
async function request(path, method = "GET", body, admin = false) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(admin ? { Authorization: "Bearer " + secrets.ADMIN_TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(r.ok, path + " " + r.status);
  return r.json();
}
await request("/auth/web/register", "POST", account);
const queue = await request(
  "/v1/admin/registration-requests",
  "GET",
  undefined,
  true,
);
const item = queue.requests.find((r) => r.username === account.username);
await request(
  "/v1/admin/registration-requests/" + item.id + "/decision",
  "POST",
  { decision: "approve" },
  true,
);
const electron = await _electron.launch({
  executablePath: createRequire(resolve("apps/desktop/package.json"))(
    "electron",
  ),
  args: [resolve("apps/desktop")],
  env: { ...process.env, PIG_DESKTOP_USER_DATA: userdata },
});
try {
  const page = await electron.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(async () => {
    localStorage.setItem("pig-agent.desktop-setup", "complete");
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cloudBaseUrl: "http://127.0.0.1:8892",
        cloudMode: "remote",
      }),
    });
    if (!r.ok) throw Error("settings failed");
  });
  await page.reload();
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
  );
  assert.ok(await page.evaluate(() => !!window.pigDesktop));
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "项目协同", exact: true }).click();
  await expect(page.locator(".cw-embedded-auth")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "项目分支" }),
  ).toBeVisible();
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".cw-embedded")).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("navigation", { name: "项目分支" }),
  ).toBeVisible();
  assert.ok(page.url().includes("projects/collaboration"));
  await page.screenshot({ path: out + "/electron-project-collaboration.png" });
  await page.getByRole("button", { name: "普通项目", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "项目", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cw-embedded")).toHaveCount(0);
  await page.screenshot({ path: out + "/electron-normal-project.png" });
  await writeFile(
    out + "/electron-report.json",
    JSON.stringify(
      {
        checks: [
          "real Electron process with native pigDesktop bridge",
          "project collaboration renders inside retained App navigation",
          "username/password login through native desktop vault proxy succeeds",
          "switch back to ordinary projects without changing workbench shell",
        ],
        origin: page.url(),
        userData: userdata,
      },
      null,
      2,
    ),
  );
} finally {
  await electron.close();
}
