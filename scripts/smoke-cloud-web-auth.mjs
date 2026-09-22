import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = process.env.PIG_CLOUD_WEB_BASE || "http://127.0.0.1:8892";
const env = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .split("\n")
    .filter((s) => s.includes("="))
    .map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
const token = process.env.PIG_CLOUD_WEB_TOKEN || env.MEMBER_TOKEN;
assert(token, "Missing isolated cluster member token");
const evidence = "data/cloud-web-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
async function api(path, options = {}) {
  return context.request.fetch(base + path, options);
}
try {
  const oldBearer = await api("/v1/me", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(oldBearer.status(), 200);
  const identity = await oldBearer.json();
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "进入你的工作空间" }),
  ).toBeVisible();
  await page.getByLabel("访问令牌", { exact: true }).fill(token);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  const cookie = (await context.cookies()).find(
    (c) => c.name === "pig_web_session",
  );
  assert(cookie?.httpOnly);
  assert.equal(cookie.sameSite, "Strict");
  assert(cookie.value !== token);
  assert(cookie.expires > Date.now() / 1000);
  assert(cookie.expires < Date.now() / 1000 + 43300);
  assert(
    !(await page.evaluate(() => document.cookie)).includes("pig_web_session"),
  );
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  assert(!JSON.stringify(storage).includes(token));
  assert(!JSON.stringify(storage).includes(cookie.value));
  checks.push(
    "Browser login creates expiring HttpOnly SameSite Strict opaque cookie; credentials absent from JS cookie/localStorage/sessionStorage",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await page.screenshot({
    path: evidence + "/auth-logged-in.png",
    fullPage: true,
  });
  checks.push("Reload retains login");
  assert.equal(
    (
      await api("/v1/runs", {
        method: "POST",
        headers: { Origin: "https://untrusted.example" },
        data: {},
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await api("/auth/web/login", {
        method: "POST",
        headers: { Origin: "https://untrusted.example" },
        data: { token },
      })
    ).status(),
    403,
  );
  checks.push("Cross-origin cookie writes and login CSRF denied");
  for (const path of [
    "/api/settings",
    "/api/sessions",
    "/api/desktop/computer/status",
  ])
    assert.equal((await api(path)).status(), 404);
  checks.push("Public Web rejects local settings/session/computer APIs");
  const openedStream = await page.evaluate(async () => {
    const data = await (await fetch("/v1/conversations")).json();
    if (!data.conversations?.[0])
      throw Error(
        "Need an existing isolated conversation for live reauthentication",
      );
    let ready;
    const first = new Promise((resolve) => {
      ready = resolve;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    window.__authRevoked = (async () => {
      try {
        const response = await fetch(
          "/v1/conversations/" + data.conversations[0].id + "/events",
          { signal: controller.signal },
        );
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return text.includes("access_revoked");
          text += decoder.decode(chunk.value, { stream: true });
          if (text.includes("conversation_snapshot")) ready(true);
          if (text.includes("access_revoked")) {
            await reader.cancel();
            return true;
          }
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    })();
    return await first;
  });
  assert(openedStream);
  await page.getByRole("button", { name: "退出登录" }).click();
  assert(await page.evaluate(() => window.__authRevoked));
  checks.push(
    "Already-open conversation SSE reports access_revoked after logout",
  );
  await expect(
    page.getByRole("heading", { name: "进入你的工作空间" }),
  ).toBeVisible();
  assert.equal((await api("/v1/me")).status(), 401);
  assert.equal(
    (
      await api("/v1/me", {
        headers: { Cookie: "pig_web_session=" + cookie.value },
      })
    ).status(),
    401,
  );
  const remaining = await api("/v1/me", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(remaining.status(), 200);
  assert.deepEqual(await remaining.json(), identity);
  checks.push(
    "Logout revokes only web cookie session, replay fails; original desktop/API bearer still works",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "进入你的工作空间" }),
  ).toBeVisible();
  await page.screenshot({
    path: evidence + "/auth-logged-out.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const result = {
    at: new Date().toISOString(),
    base,
    browser: "real Chrome / Playwright isolated context",
    checks,
    errors,
  };
  await writeFile(
    evidence + "/auth-browser.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await context.close();
  await browser.close();
}
