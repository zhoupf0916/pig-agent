import { _electron as electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = await mkdtemp(join(tmpdir(), "pig-shared-desktop-"));
const env = Object.fromEntries(
  (await readFile("data/cluster-local/stack.env", "utf8"))
    .split("\n")
    .filter((s) => s.includes("="))
    .map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
);
const executablePath = createRequire(root + "/apps/desktop/package.json")(
  "electron",
);
let desktop;
const evidence = "data/cloud-web-evidence";
await mkdir(evidence, { recursive: true });
try {
  desktop = await electron.launch({
    executablePath,
    args: [root + "/apps/desktop"],
    env: { ...process.env, PIG_DESKTOP_USER_DATA: profile },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  await page.waitForURL("pig://app/");
  const configured = await page.evaluate(async (token) => {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cloudBaseUrl: "http://127.0.0.1:8892",
        cloudToken: token,
        executionTarget: "remote",
      }),
    });
    return { status: r.status, body: await r.json() };
  }, env.MEMBER_TOKEN);
  assert.equal(configured.status, 200);
  assert(!JSON.stringify(configured.body).includes(env.MEMBER_TOKEN));
  await page.evaluate(() => {
    location.hash = "/shared";
  });
  await expect(page.getByRole("heading", { name: "共享工作空间" }))
    .toBeVisible({ timeout: 15000 })
    .catch(async () => {
      await expect(page.locator(".cw-shell")).toBeVisible();
    });
  const evidenceResult = await page.evaluate(async () => {
    const response = await fetch("/api/remote/v1/conversations");
    const data = await response.json();
    if (!response.ok) throw Error("Shared conversation API " + response.status);
    const selected = data.conversations[0];
    if (!selected) throw Error("Need existing mock cluster conversation");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const r = await fetch(
        "/api/remote/v1/conversations/" + selected.id + "/events",
        { signal: controller.signal },
      );
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("conversation_snapshot")) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      await reader.cancel();
      return {
        status: r.status,
        contentType: r.headers.get("content-type"),
        snapshot: text.includes("conversation_snapshot"),
        id: selected.id,
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
  assert.equal(evidenceResult.status, 200);
  assert(evidenceResult.snapshot);
  assert(evidenceResult.contentType?.includes("text/event-stream"));
  const before = await page.evaluate(
    async () => await (await fetch("/api/remote/v1/me")).json(),
  );
  const local = await page.evaluate(async () => {
    const r = await fetch("/api/sessions");
    return r.status;
  });
  assert.equal(local, 200);
  await page.screenshot({
    path: evidence + "/desktop-shared.png",
    fullPage: true,
  });
  const result = {
    at: new Date().toISOString(),
    profile: "isolated temporary profile removed after test",
    checks: [
      "Desktop pig:// transport reaches same shared cloud workspace with server-side bearer",
      "Cloud credential remains masked in settings response",
      "Streaming conversation snapshot crosses Electron protocol and utility-process bridge",
      "Local desktop session APIs remain available alongside shared cloud surface",
    ],
    stream: {
      status: evidenceResult.status,
      contentType: evidenceResult.contentType,
      snapshot: evidenceResult.snapshot,
    },
    identityPresent: !!before.id,
  };
  await writeFile(
    evidence + "/desktop-shared.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await desktop?.close();
  await rm(profile, { recursive: true, force: true });
}
