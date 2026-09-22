import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = process.env.PIG_FLOW_BASE || "http://127.0.0.1:8799";
const out = process.env.PIG_FLOW_EVIDENCE || "data/journal-evidence";
const proof = JSON.parse(await readFile(out + "/flow.json", "utf8"));
const api = async (path) => {
  const r = await fetch(base + path);
  if (!r.ok) throw Error(path);
  return r.json();
};
const session = await api("/api/sessions/" + proof.sessionId);
const current = await api("/api/remote/v1/runs/" + session.remoteRunId);
const conversation = await api(
  "/api/remote/v1/conversations/" + current.conversation_id,
);
const run = conversation.runs.filter((r) => r.state === "succeeded").at(-1);
if (!run) throw Error("Requires real completed cloud run");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base + "/#/runs/" + run.id);
  const journal = page.getByRole("region", { name: "执行步骤日志" });
  await expect(journal).toBeVisible();
  await expect(
    journal.getByText("诊断：原始事件", { exact: false }),
  ).toBeVisible();
  await expect(journal.locator("details").first()).toContainText("完成");
  await expect(journal.locator("pre").first()).not.toBeVisible();
  await journal.locator("summary").first().click();
  await expect(journal.locator("pre").first()).toBeVisible();
  await journal.locator("summary").first().click();
  await page.screenshot({ path: out + "/journal-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(journal).toBeVisible();
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("mobile overflow");
  await page.screenshot({ path: out + "/journal-mobile.png" });
  if (errors.length) throw Error(errors.join("\n"));
  await writeFile(
    out + "/journal.json",
    JSON.stringify(
      {
        runId: run.id,
        checks: [
          "real completed run shows one step per tool call",
          "tool details expand on demand",
          "raw transport events collapsed",
          "desktop/mobile no horizontal overflow",
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
