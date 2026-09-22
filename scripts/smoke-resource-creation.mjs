import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const evidence = resolve("data/creation-evidence");
const data = resolve("data/creation-smoke-runtime");
await mkdir(evidence, { recursive: true });
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });
const requests = [];
// Explicit deterministic test provider; never uses user API keys or task data.
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const user = body.messages.at(-1).content;
  const isSkill = body.messages[0].content.includes("技能操作指南");
  const content = user.includes("故障") ? "invalid fixture output" : JSON.stringify(isSkill ? {
    name: "sales-review", description: "检查销售数据并交付异常报告",
    body: "## 适用场景\n分析销售 CSV。\n## 步骤\n1. 检查字段、日期范围和缺失值。\n2. 汇总销售额并找出异常。\n3. 核对总额，报告依据和不确定性。",
  } : {
    name: "销售分析专家", description: "整理销售问题并设计可验证的分析步骤",
    instruction: "先确认数据范围和口径，再核对字段并分析销售异常。交付结论、依据、限制与复核步骤。涉及写入须遵循当前任务审批。",
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => provider.listen(0, "127.0.0.1", r));
const port = provider.address().port;
const server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
  env: { ...process.env, PIG_DESKTOP: "1", PORT: "8801", DATA_DIR: data, LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_API_KEY: "fixture-only", LLM_MODEL: "creation-fixture" }, stdio: "ignore",
});
const base = "http://127.0.0.1:8801";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", e => errors.push(e.message));
const api = async (path, body, method = body ? "POST" : "GET") => {
  const response = await fetch(base + path, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  assert(response.ok, `${path} ${response.status}`); return response.json();
};
const checks = [];
try {
  await expect.poll(async () => { try { return (await fetch(base + "/api/health")).status; } catch { return 0; } }).toBe(200);
  await page.goto(base + "/#/experts");
  await page.getByRole("button", { name: "一句话创建专家", exact: true }).click();
  const expertForm = page.getByRole("region", { name: "创建专家", exact: true });
  await expertForm.getByLabel("你希望专家做什么？").fill("故障测试，请保留我的输入");
  await expertForm.getByRole("button", { name: "生成草稿", exact: true }).click();
  await expect(expertForm.getByRole("alert")).toContainText("草稿格式不完整");
  await expect(expertForm.getByLabel("你希望专家做什么？")).toHaveValue("故障测试，请保留我的输入");
  await page.screenshot({ path: evidence + "/generation-error-desktop.png" });
  checks.push("invalid provider output shows actionable error and retains input, retry succeeds");
  await expertForm.getByLabel("你希望专家做什么？").fill("帮助电商团队分析销售问题的专家");
  await expertForm.getByRole("button", { name: "生成草稿", exact: true }).click();
  await expect(expertForm.getByLabel("专家名称", { exact: true })).toHaveValue("销售分析专家");
  const before = (await api("/api/experts")).experts;
  assert(!before.some(e => e.name === "销售分析专家"));
  await expertForm.getByLabel("专家名称", { exact: true }).fill("销售分析专家（已审阅）");
  await page.screenshot({ path: evidence + "/expert-draft-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: evidence + "/expert-draft-mobile.png", fullPage: true });
  await expertForm.getByRole("button", { name: "确认创建专家", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/expert-confirm-mobile.png" });
  await expertForm.getByRole("button", { name: "确认创建专家", exact: true }).click();
  await expect(page.getByRole("heading", { name: "销售分析专家（已审阅）", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "销售分析专家（已审阅）", exact: true })).toBeVisible();
  const expert = (await api("/api/experts")).experts.find(e => e.name === "销售分析专家（已审阅）");
  assert(expert);
  // Binding follows the same existing task API; browser activates the pin action.
  await page.getByRole("button", { name: "绑定到当前会话", exact: true }).click();
  await expect.poll(async () => (await api("/api/sessions")).sessions.some(s => s.expertId === expert.id)).toBe(true);
  checks.push("expert generated through fixture provider, edited in browser, explicitly saved, reload retained and bound to task");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /一句话创建与本地技能/ }).click();
  await page.getByRole("button", { name: "一句话创建技能", exact: true }).click();
  const skillForm = page.getByRole("region", { name: "创建技能", exact: true });
  await skillForm.getByLabel("你希望技能做什么？").fill("分析销售 CSV 并核对异常");
  await skillForm.getByRole("button", { name: "生成草稿", exact: true }).click();
  await expect(skillForm.getByLabel("技能标识（小写英文、数字、连字符）")).toHaveValue("sales-review");
  assert(!(await api("/api/skills")).skills.some(s => s.name === "sales-review"));
  await skillForm.getByLabel("技能步骤").fill("先检查 CSV 字段与缺失值，再汇总销售额，报告异常并核对总额。验收标记：sales-proof");
  await page.screenshot({ path: evidence + "/skill-draft-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: evidence + "/skill-draft-mobile.png", fullPage: true });
  await skillForm.getByRole("button", { name: "确认创建技能", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: evidence + "/skill-confirm-mobile.png" });
  await skillForm.getByRole("button", { name: "确认创建技能", exact: true }).click();
  await expect.poll(async () => (await api("/api/skills")).skills.some(s => s.name === "sales-review")).toBe(true);
  await page.reload();
  assert((await api("/api/skills")).skills.some(s => s.name === "sales-review"));
  // Load using the actual agent skill loader in the same isolated data directory.
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {loadSkill}=await import('./apps/server/src/agent/skills.ts'); const skill=await loadSkill('sales-review'); if(!skill.body.includes('sales-proof'))process.exit(1); console.log('effective');"], { env: { ...process.env, PIG_DESKTOP: "1", DATA_DIR: data } });
    let output = ""; child.stdout.on("data", b => output += b); child.on("error", reject); child.on("exit", code => resolveResult({ code, output }));
  });
  assert.equal(result.code, 0);
  checks.push("skill generated, edited, explicitly persisted, reload lists skill and agent loadSkill returns edited body");
  assert(requests.every(r => !r.tools && !r.tool_choice));
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(evidence + "/checks.json", JSON.stringify({ at: new Date().toISOString(), environment: "Chrome headless; isolated server8801; explicit deterministic model fixture (real provider unverified)", checks, requests: requests.length, errors }, null, 2));
  console.log(checks.join("\n"));
} finally {
  await browser.close(); server.kill("SIGTERM"); await new Promise(r => provider.close(r));
}
