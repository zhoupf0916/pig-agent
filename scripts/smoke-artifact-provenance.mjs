/** Real authorized control-plane snapshots. No UI responses are mocked. */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
const base = process.env.PIG_REVIEW_BASE || "http://127.0.0.1:8799";
const out = process.env.PIG_REVIEW_EVIDENCE || "data/redesign-evidence";
await mkdir(out, { recursive: true });
async function api(path, init) {
  const r = await fetch(base + path, init);
  if (!r.ok) throw Error(path + " HTTP " + r.status);
  return r.json();
}
const settings = await api("/api/settings");
// This regression deliberately mutates a same-named host file, only in the
// isolated review workspace. It never operates on a user's configured project.
assert.ok(
  ["/data/acceptance-review/workspace", "/data/redesign-local/workspace", "/data/product-workspace"].some(
    (suffix) => resolve(settings.workspaceRoot).endsWith(suffix),
  ),
  "requires isolated review workspace",
);
const summaries = await api("/api/sessions");
const sessions = await Promise.all(
  (Array.isArray(summaries) ? summaries : summaries.sessions).map((s) =>
    api("/api/sessions/" + s.id),
  ),
);
let session, conversation;
let successfulRuns;
for (const candidate of sessions.filter(
  (s) =>
    s.remoteRunId && s.artifacts?.some((a) => a.path === "cloud-proof.txt"),
)) {
  const run = await api("/api/remote/v1/runs/" + candidate.remoteRunId);
  if (!run.conversation_id) continue;
  const data = await api("/api/remote/v1/conversations/" + run.conversation_id);
  const completed=data.runs.filter(run=>run.state === "succeeded");
  if (completed.length >= 2) {
    successfulRuns=completed;
    session = candidate;
    conversation = data;
    break;
  }
}
assert.ok(
  session && conversation,
  "requires completed real cloud proof session with two actual runs",
);
const host = join(settings.workspaceRoot, "cloud-proof.txt");
const original = await readFile(host).catch(() => null);
const browser = await chromium.launch({
  channel:
    process.env.PIG_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const requests = [];
page.on("request", (r) => {
  if (r.url().includes("/workspace/file") || /\/artifacts\//.test(r.url()))
    requests.push(new URL(r.url()).pathname + new URL(r.url()).search);
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const evidence = {
  session: session.id,
  latestRun: session.remoteRunId,
  versions: [],
  scenarios: [],
};
async function openInspector() {
  await expect(
    page.getByRole("region", { name: "当前远端执行" }),
  ).toBeVisible();
  const panel = page.getByRole("complementary", { name: "远端成果检查器" });
  const trigger = page.getByRole("button", { name: "文件与产物", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(panel).toBeVisible();
  await panel.getByLabel("所属运行 / 版本").selectOption(successfulRuns.at(-1).id);
  return panel;
}
try {
  await unlink(host).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  await page.goto(base + "/#/sessions/" + session.id);
  let panel = await openInspector();
  await expect(
    panel.getByRole("region", { name: "远端文件内容" }),
  ).toContainText("PIG_CLOUD_CONTAINER_OK");
  evidence.scenarios.push("absent local file: authorized remote content shown");
  await writeFile(host, "LOCAL_ONLY_REVIEW_SENTINEL\n");
  await page.reload();
  panel = await openInspector();
  await expect(
    panel.getByRole("region", { name: "远端文件内容" }),
  ).toContainText("PIG_CLOUD_CONTAINER_OK");
  await expect(panel).not.toContainText("LOCAL_ONLY_REVIEW_SENTINEL");
  evidence.scenarios.push(
    "same-name different local content: no host bytes displayed",
  );
  for (const run of [successfulRuns[0], successfulRuns.at(-1)]) {
    const artifacts = await api("/api/remote/v1/runs/" + run.id + "/artifacts");
    const artifact = artifacts.artifacts.find(
      (a) => a.path === "cloud-proof.txt",
    );
    assert.ok(artifact);
    const expected = await fetch(
      base + "/api/remote/v1/runs/" + run.id + "/artifacts/" + artifact.id,
    ).then((r) => r.text());
    await panel.getByLabel("所属运行 / 版本").selectOption(run.id);
    await expect(
      panel.getByRole("region", { name: "远端文件内容" }),
    ).toContainText(expected.trim());
    await expect(
      panel.getByRole("link", { name: "下载", exact: true }),
    ).toHaveAttribute(
      "href",
      `/api/remote/v1/runs/${run.id}/artifacts/${artifact.id}`,
    );
    evidence.versions.push({
      runId: run.id,
      artifactId: artifact.id,
      content: expected,
    });
  }
  assert.notEqual(
    evidence.versions[0].artifactId,
    evidence.versions[1].artifactId,
  );
  assert.equal(
    requests.filter((url) => url.includes("/workspace/file")).length,
    0,
    "remote preview must never request host files",
  );
  await page.screenshot({ path: out + "/artifact-source-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("link", { name: "下载", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: out + "/artifact-source-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const createImport = page.waitForResponse(
    (r) =>
      r.url().includes("/api/remote/stage-artifacts/") &&
      r.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "审阅并导入到本机", exact: true })
    .click();
  const imported = await (await createImport).json();
  await page.waitForURL("**/#/sessions/" + imported.id);
  assert.equal(await readFile(host, "utf8"), "LOCAL_ONLY_REVIEW_SENTINEL\n");
  evidence.scenarios.push(
    "explicit import stages a separate local review without writing",
  );
  if (
    !(await page
      .getByRole("dialog", { name: "执行与验收", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: /执行与验收/ })
      .first()
      .click();
  await page.getByRole("button", { name: "批准执行", exact: true }).click();
  await expect
    .poll(() => readFile(host, "utf8"))
    .toBe("PIG_CLOUD_CONTAINER_OK\n");
  evidence.scenarios.push(
    "approved import writes exact remote bytes into isolated local workspace",
  );
  await page.goto(base + "/#/sessions/" + session.id);
  panel = await openInspector();
  await expect(
    panel.getByRole("region", { name: "远端文件内容" }),
  ).toContainText("PIG_CLOUD_CONTAINER_OK");
  await expect(panel).toContainText("远端快照");
  evidence.scenarios.push(
    "switch back after import retains original remote identity",
  );
  assert.deepEqual(errors, []);
  // Host reads may occur in the explicitly local import task, but none before
  // that point are permitted. Remote content URLs themselves always contain IDs.
  evidence.requests = requests;
  evidence.errors = errors;
  evidence.importSession = imported.id;
  await writeFile(
    out + "/artifact-source.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (original) await writeFile(host, original);
  else await unlink(host).catch(() => {});
  await browser.close();
}
