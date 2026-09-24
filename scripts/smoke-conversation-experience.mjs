import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const dataDir = process.env.PIG_SMOKE_DATA_DIR;
const repoData = resolve("data");
if (!dataDir) {
  console.error("PIG_SMOKE_DATA_DIR is required. Point it at an empty directory outside this repository's data folder. This script will not read or write user data.");
  process.exit(1);
}
const outputRoot = resolve(dataDir);
const fromRepoData = relative(repoData, outputRoot);
if (fromRepoData === "" || (!fromRepoData.startsWith(`..${sep}`) && fromRepoData !== "..")) {
  console.error(`Refusing to use ${outputRoot}. It is inside the repository data directory.`);
  process.exit(1);
}
await mkdir(outputRoot, { recursive: true });
const absData = await mkdtemp(join(outputRoot, "run-"));
const out = join(absData, "evidence");
await mkdir(join(absData, "sessions"), { recursive: true });
await mkdir(join(absData, "workspace"), { recursive: true });
await mkdir(out, { recursive: true });

const now = "2026-09-24T10:00:00.000Z";
const longOutput = `${"完整工具输出甲".repeat(80)}TAIL_MARKER_9981`;
const usage = {
  availability: "collected", unit: "estimated_chars", measuredTokens: false, scope: "last_call",
  note: "字符估算，最近一次模型调用。不是供应商 token 窗口，也不是累计计费 token。",
  capturedAt: now, callId: "ctx_smoke", engine: "pig",
  usedChars: 20000, budgetChars: 80000, ratio: 0.25,
  systemChars: 3000, toolSchemaChars: 4000, messageChars: 13000,
  omittedMessages: 1, trimmedToolResults: 2,
};
function session(id, extra) {
  return {
    id, title: extra.title, deliveryMode: true, createdAt: now, updatedAt: now,
    status: extra.status ?? "idle", messages: extra.messages ?? [], steps: [], artifacts: [],
    eventCheckpointSeq: 0, lastError: extra.lastError, lastContextUsage: extra.usage,
  };
}
const user = (id, content) => ({ id, role: "user", content, createdAt: now });
const assistant = (id, content, toolCalls) => ({ id, role: "assistant", content, createdAt: now, ...(toolCalls ? { toolCalls } : {}) });
const toolMsg = (id, call, content) => ({ id, role: "tool", content, toolCallId: call, toolOk: true, createdAt: now });
const fixtures = {
  ses_smoke_empty: session("ses_smoke_empty", { title: "空对话" }),
  ses_smoke_two: session("ses_smoke_two", {
    title: "两轮",
    usage,
    messages: [
      user("u1", "第一轮：检查启动说明"),
      assistant("a1", "我先读取说明。", [{ id: "c1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }]),
      toolMsg("t1", "c1", longOutput),
      assistant("a2", "第一轮结论：用 pnpm dev 启动网页。"),
      user("u2", "第二轮：再确认测试命令"),
      assistant("a3", "第二轮结论：用 pnpm test 验证。"),
    ],
  }),
  ses_smoke_running: session("ses_smoke_running", {
    title: "执行中", status: "running",
    messages: [
      user("u1", "正在核对配置"),
      assistant("a1", "正在读取配置。", [{ id: "c1", name: "read_file", arguments: "{\"path\":\"package.json\"}" }]),
    ],
  }),
  ses_smoke_approval: session("ses_smoke_approval", {
    title: "等待批准",
    messages: [
      user("u1", "请修改说明"),
      assistant("a1", "", [{ id: "c1", name: "write_file", arguments: "{\"path\":\"README.md\"}" }]),
      { id: "t1", role: "tool", content: "待批准写入 README.md", toolCallId: "c1", toolOk: false, createdAt: now },
    ],
  }),
  ses_smoke_failed: session("ses_smoke_failed", {
    title: "失败", status: "error", lastError: "本轮执行失败：沙箱拒绝了命令。",
    messages: [user("u1", "运行检查"), assistant("a1", "我先查看脚本。", [{ id: "c1", name: "run_shell", arguments: "{}" }]), { id: "t1", role: "tool", content: "Error: denied", toolCallId: "c1", toolOk: false, createdAt: now }],
  }),
  ses_smoke_cancelled: session("ses_smoke_cancelled", {
    title: "已取消",
    messages: [user("u1", "整理目录"), assistant("a1", "已停止。已完成的步骤仍可审阅。")],
  }),
};
for (const [id, body] of Object.entries(fixtures)) {
  await writeFile(join(absData, "sessions", `${id}.json`), JSON.stringify(body));
}

const localPort = 18791;
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_|PIG_CLOUD_)/.test(key),
));
const local = spawn("node", ["--import", "tsx", "apps/server/src/index.ts"], {
  env: { ...isolatedEnv, DATA_DIR: absData, WORKSPACE_ROOT: join(absData, "workspace"), PORT: String(localPort), PIG_DESKTOP: "1", PIG_LOCAL_WORKBENCH: "1", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "smoke-not-a-model-key" },
  stdio: ["ignore", "pipe", "pipe"],
});
function cloudSnapshot(id) {
  const scenes = {
    conv_empty: { title: "空对话", state: "succeeded", messages: [], error: null },
    conv_two: {
      title: "两轮", state: "succeeded", error: null,
      messages: [
        { id: "prompt:run_a", role: "user", content: "云端第一轮", createdAt: now, author: { name: "协作成员甲" } },
        { id: "pre", role: "assistant", content: "我先查看云端文件。", createdAt: now, phase: "progress" },
        { id: "ans1", role: "assistant", content: "云端第一轮结论。", createdAt: now, phase: "answer" },
        { id: "prompt:run_b", role: "user", content: "云端第二轮", createdAt: now, author: { name: "协作成员乙" } },
        { id: "ans2", role: "assistant", content: "云端第二轮结论。", createdAt: now, phase: "answer" },
      ],
    },
    conv_running: { title: "执行中", state: "running", error: null, messages: [{ id: "prompt:run_r", role: "user", content: "云端执行中", createdAt: now, outcome: "running", notice: "正在执行" }] },
    conv_approval: { title: "等待批准", state: "running", error: null, messages: [{ id: "prompt:run_p", role: "user", content: "云端等待批准", createdAt: now, outcome: "approval", notice: "需要批准后才会继续" }] },
    conv_failed: { title: "失败", state: "failed", error: "云端本轮执行失败", messages: [{ id: "prompt:run_f", role: "user", content: "云端失败", createdAt: now, outcome: "failed", notice: "云端本轮执行失败" }, { id: "pre", role: "assistant", content: "我先读取。", createdAt: now, phase: "progress" }] },
    conv_cancelled: { title: "已取消", state: "cancelled", error: "已取消", messages: [{ id: "prompt:run_c", role: "user", content: "云端取消", createdAt: now, outcome: "cancelled", notice: "已取消" }] },
  };
  const scene = scenes[id];
  const runId = `run_${id}`;
  return {
    conversation: { id, title: scene.title, can_write: true },
    runs: id === "conv_two" ? [
      { id: "run_a", state: "succeeded", attachments: [{ id: "att_a", name: "第一轮说明.txt", size: 15 }], author: { name: "协作成员甲" } },
      { id: "run_b", state: "succeeded", attachments: [{ id: "att_b", name: "第二轮测试.txt", size: 18 }], author: { name: "协作成员乙" } },
    ] : [{ id: runId, state: scene.state, error: scene.error, prompt: scene.messages[0]?.content || "", created_at: now, updated_at: now, author: { id: "prin_smoke", name: "验收" } }],
    messages: scene.messages,
    lastContextUsage: id === "conv_two" ? { ...usage, engine: "cloud" } : undefined,
    versions: [],
  };
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const cloud = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/deployment") return json(res, { surface: "cloud" });
  if (url.pathname === "/v1/me") return json(res, { id: "prin_smoke", name: "验收" });
  if (url.pathname === "/v1/conversations") {
    return json(res, { conversations: Object.keys(cloudSnapshot("conv_empty")).length ? ["conv_empty", "conv_two", "conv_running", "conv_approval", "conv_failed", "conv_cancelled"].map((id) => ({ id, title: cloudSnapshot(id).conversation.title })) : [] });
  }
  if (url.pathname === "/v1/projects") return json(res, { projects: [] });
  if (url.pathname === "/v1/spaces") return json(res, { spaces: [] });
  if (url.pathname === "/v1/experts") return json(res, { experts: [] });
  if (url.pathname === "/v1/skills") return json(res, { skills: [] });
  if (url.pathname === "/v1/settings") return json(res, { requireApproval: true, networkPolicy: "blocked" });
  const approvals = url.pathname.match(/^\/v1\/runs\/(run_[a-z_]+)\/approvals$/);
  if (approvals) {
    const pending = approvals[1] === "run_conv_approval";
    return json(res, { approvals: pending ? [{ id: "ap1", state: "pending", tool: "write_file", args: { path: "README.md" } }] : [] });
  }
  if (url.pathname.endsWith("/artifacts")) return json(res, { artifacts: [] });
  const events = url.pathname.match(/^\/v1\/conversations\/(conv_[a-z_]+)\/events$/);
  if (events) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const sendSnapshot = () => res.write(`data: ${JSON.stringify({ type: "conversation_snapshot", ...cloudSnapshot(events[1]) })}\n\n`);
    if (events[1] === "conv_empty") setTimeout(sendSnapshot, 700);
    else sendSnapshot();
    const timer = setInterval(() => res.write("event: heartbeat\ndata: {}\n\n"), 5000);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) return json(res, {});
  const file = join("apps/web/dist", url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
function json(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
await new Promise((ready) => cloud.listen(18792, "127.0.0.1", ready));
try {
await waitFor(`http://127.0.0.1:${localPort}/`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
const errors = [];
const shots = [
  ["local-empty", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_empty`, "空对话"],
  ["local-two", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_two`, "第一轮结论"],
  ["local-running", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_running`, "正在核对配置"],
  ["local-approval", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_approval`, "等待批准"],
  ["local-failed", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_failed`, "本轮执行失败"],
  ["local-cancelled", `http://127.0.0.1:${localPort}/#/sessions/ses_smoke_cancelled`, "已停止"],
  ["cloud-empty", "http://127.0.0.1:18792/#/conversations/conv_empty", "空对话"],
  ["cloud-two", "http://127.0.0.1:18792/#/conversations/conv_two", "云端第二轮结论"],
  ["cloud-running", "http://127.0.0.1:18792/#/conversations/conv_running", "正在执行"],
  ["cloud-approval", "http://127.0.0.1:18792/#/conversations/conv_approval", "需要批准"],
  ["cloud-failed", "http://127.0.0.1:18792/#/conversations/conv_failed", "云端本轮执行失败"],
  ["cloud-cancelled", "http://127.0.0.1:18792/#/conversations/conv_cancelled", "已取消"],
];
try {
  for (const [name, url, text] of shots) {
    for (const [viewport, width, height] of [["desktop1440", 1440, 900], ["mobile390", 390, 844], ["mobile320", 320, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", (error) => errors.push(`${name}:${error.message}`));
      await page.goto(url);
      await expect(page.locator("h1, .conv-user, .conv-answer, .conv-notice, .conv-alert, .conv-current, .cw-approval").filter({ hasText: text }).locator("visible=true").first()).toBeVisible({ timeout: 20000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (name.startsWith("local-") && name !== "local-running") await expect(page.getByRole("textbox", { name: "任务消息" })).toBeEnabled();
      if (name === "local-two" && viewport !== "desktop1440") {
        const ring = page.getByRole("button", { name: "上下文用量" });
        await ring.click();
        const dialog = page.getByRole("dialog", { name: "最近一次调用" });
        await expect(dialog).toBeVisible();
        await expect(page.getByText("分母是本次输入字符预算，不是计费 token")).toBeVisible();
        const box = await dialog.boundingBox();
        if (!box) throw new Error("context popover has no box");
        const outside = box.x < -1 || box.y < -1 || box.x + box.width > width + 1 || box.y + box.height > height + 1;
        if (outside) throw new Error(`popover outside ${viewport}: ${JSON.stringify(box)}`);
        await page.screenshot({ path: join(out, `context-${viewport}.png`), fullPage: true });
        await page.getByRole("button", { name: "关闭上下文详情" }).click();
        await expect(dialog).toBeHidden();
        await expect(ring).toBeFocused();
        checks.push(`${viewport} popover inside viewport`);
      }
      if (name === "local-two" && viewport === "desktop1440") {
        await page.locator(".conv-activity").first().click();
        await page.locator(".conv-log-item").first().click();
        await expect(page.getByText("TAIL_MARKER_9981")).toBeVisible();
        await page.screenshot({ path: join(out, "expanded-tool-output.png"), fullPage: true });
        const ring = page.getByRole("button", { name: "上下文用量" });
        await ring.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByText("分母是本次输入字符预算，不是计费 token")).toBeVisible();
        await expect(page.getByText("3,000 · 3.8%", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.locator(".conv-activity > summary").first().click();
        checks.push("expanded full tool output and budget shares");
      }
      if (name === "cloud-two" && viewport === "desktop1440") {
        await expect(page.locator(".conv-answer", { hasText: "我先查看云端文件" })).toHaveCount(0);
        const turns = page.locator(".conv-turn");
        await expect(turns.nth(0)).toContainText("协作成员甲");
        await expect(turns.nth(0).getByRole("link", { name: /第一轮说明/ })).toHaveAttribute("href", "/v1/attachments/att_a/download");
        await expect(turns.nth(1)).toContainText("协作成员乙");
        await expect(turns.nth(1).getByRole("link", { name: /第二轮测试/ })).toHaveAttribute("href", "/v1/attachments/att_b/download");
        checks.push("collaboration authors and attachment links stay on their own turns");
        checks.push("cloud progress is not the final answer");
      }
      await page.screenshot({ path: join(out, `${name}-${viewport}.png`), fullPage: true });
      if (name === "cloud-two" && viewport === "desktop1440") {
        await page.getByRole("button", { name: "空对话", exact: true }).click();
        await expect(page.getByRole("button", { name: "上下文用量" })).toContainText("未采集", { timeout: 200 });
        checks.push("switching conversations clears the previous context before the new snapshot arrives");
      }
      await page.close();
    }
  }
  await writeFile(join(out, "checks.json"), JSON.stringify({ dataDir: absData, checks, errors, note: "Fixtures were written by this script. No live model was called." }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("smoke ok", checks.join("; "), "Evidence:", out);
} finally {
  await browser.close();
  cloud.close();
  local.kill("SIGTERM");
}
} catch (error) {
  cloud.close();
  local.kill("SIGTERM");
  throw error;
}

async function waitFor(url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not start: ${url}`);
}
