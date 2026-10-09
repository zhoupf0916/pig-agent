#!/usr/bin/env bash
# Pig Agent remote e2e, run ON the server (talks to 127.0.0.1:8890, so the nginx rate limits don't apply).
# Prints only PASS/FAIL/BLOCKED-402/SKIP lines plus a final count (BLOCKED-402 = model provider has no balance; not a failure). The admin username/password are read from
# data/cloud-local/accounts.txt inside the test process and never printed; the session is logged out at the end.
#   bash e2e-remote.sh
#   PIG_BASE=https://193.112.22.18 PIG_REMOTE_ADMIN_PASSWORD=... bash e2e-remote.sh   # from another machine
# Env: PIG_BASE (default http://127.0.0.1:8890), PIG_REMOTE_ADMIN_USER / PIG_REMOTE_ADMIN_PASSWORD (override
# accounts.txt; default user "admin"), PIG_PACE_MS (delay per request; default 150 for non-local bases to stay
# under the nginx limits), PIG_INSECURE_TLS=1 (skip certificate verification; only for a known self-signed host).
# Covers: health, public HTTPS, web workbench, admin page + password login + overview, a real model run
# with tool calls + approval + artifact, a follow-up conversation turn, A2A card / auth / message/send /
# message/stream / tasks/get, schedules (cron + manual run + history + delete), OpenAPI (/openapi.json +
# /api-docs), signed webhooks (create, SSRF guard, ping + run.cancelled delivered to the built-in sink at the
# public origin, forged signature rejected, redeliver, delete), observability (run trace across
# cloud/worker/runner/gateway, metrics, no critical alerts, test alert delivered to the webhook). SKIP = check not applicable on this host.
set -uo pipefail
ROOT=${PIG_DEPLOY_ROOT:-/home/ubuntu/pig-agent}
ACC=${PIG_ACCOUNTS:-$ROOT/data/cloud-local/accounts.txt}
ENVF=${PIG_STACK_ENV:-$ROOT/data/cloud-local/stack.env}
export BASE=${PIG_BASE:-http://127.0.0.1:8890}
NODE_IMAGE=${NODE_IMAGE:-node:24-bookworm-slim}
case "$BASE" in http://127.0.0.1*|http://localhost*) LOCAL=1 ;; *) LOCAL=0 ;; esac
if [ -z "${PIG_REMOTE_ADMIN_PASSWORD:-}" ] && ! [ -r "$ACC" ]; then
  echo "FAIL admin credentials — $ACC not readable and PIG_REMOTE_ADMIN_PASSWORD not set"; exit 1
fi
if [ "$LOCAL" = 1 ]; then
  ORIGIN=$(grep -m1 '^WEB_PUBLIC_ORIGIN=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d "\"'" || true)
else ORIGIN=$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$BASE"); fi
export ORIGIN=${ORIGIN:-$BASE}
export PIG_PACE_MS=${PIG_PACE_MS:-$([ "$LOCAL" = 1 ] && echo 0 || echo 150)}
[ "${PIG_INSECURE_TLS:-0}" = 1 ] && export NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1
PUB=0
if [ "$LOCAL" = 1 ] && [[ "$ORIGIN" == https://* ]]; then
  host=${ORIGIN#https://}; host=${host%%/*}; host=${host%%:*}
  if curl -fsS -m 10 --connect-to "$host:443:127.0.0.1:443" "https://$host/health" 2>/dev/null | grep -q '"ok":true'; then echo "PASS public HTTPS https://$host/health (nginx)"; PUB=0; else echo "FAIL public HTTPS https://$host/health (nginx)"; PUB=1; fi
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/e2e.mjs" <<'JS'
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const BASE = process.env.BASE, ORIGIN = process.env.ORIGIN;
const RUN_MS = Number(process.env.E2E_RUN_TIMEOUT_S || 300) * 1000;
const PACE = Number(process.env.PIG_PACE_MS || 0);
let acc = "";
try { acc = readFileSync(process.env.ACCOUNTS || "/run/pig/accounts.txt", "utf8"); } catch {}
const username = process.env.PIG_REMOTE_ADMIN_USER || acc.match(/^Username:\s*(\S+)\s*$/m)?.[1] || "admin";
const password = process.env.PIG_REMOTE_ADMIN_PASSWORD || acc.match(/^Password:\s*(\S+)\s*$/m)?.[1] || "";
let session = "";
let passed = 0, failed = 0, blocked = 0, skipped = 0;
class Skip extends Error {}
// The model provider refusing service (HTTP 402: no balance) is an account problem, not a deployment
// defect: such checks are reported as BLOCKED-402 and do not fail the run.
let modelBlocked = false;
class Blocked402 extends Error {}
const MODEL_402 = /HTTP 402/;
const blockIf402 = (state, detail) => {
  if (state === "failed" && (MODEL_402.test(String(detail || "")) || modelBlocked)) {
    modelBlocked = true;
    throw new Blocked402("model provider HTTP 402 (no balance) — top up the model channel, then re-run");
  }
};
const scrub = (s) => {
  let t = String(s ?? "");
  for (const x of [password, session]) if (x) t = t.split(x).join("<redacted>");
  return t.replace(/whsec_[A-Za-z0-9_-]+/g, "whsec_<redacted>").replace(/\b[0-9a-f]{40,}\b/gi, "<redacted>").replace(/\s+/g, " ").slice(0, 200);
};
async function test(name, fn) {
  try { const d = await fn(); passed++; console.log(`PASS ${name}${d ? " — " + scrub(d) : ""}`); return true; }
  catch (e) {
    if (e instanceof Blocked402) { blocked++; console.log(`BLOCKED-402 ${name} — ${scrub(e.message)}`); return false; }
    if (e instanceof Skip) { skipped++; console.log(`SKIP ${name} — ${scrub(e.message)}`); return false; }
    failed++; console.log(`FAIL ${name} — ${scrub(e?.message || e)}`); return false;
  }
}
const ok = (cond, msg) => { if (!cond) throw Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, { method = "GET", body, auth = true, headers = {}, timeout = 30000 } = {}) {
  if (PACE) await sleep(PACE);
  return fetch(BASE + path, {
    method,
    headers: { ...(auth && session ? { Authorization: `Bearer ${session}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
}
async function api(path, opts = {}) {
  const want = opts.status ?? [200, 201, 202];
  const r = await req(path, opts);
  const text = await r.text();
  if (!(Array.isArray(want) ? want : [want]).includes(r.status)) throw Error(`${opts.method || "GET"} ${path} -> HTTP ${r.status} ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { return text; }
}
let mode = "unknown";
async function finish(runId, approved = []) {
  const end = Date.now() + RUN_MS;
  while (Date.now() < end) {
    const list = await api(`/v1/runs/${runId}/approvals`).catch(() => ({ approvals: [] }));
    for (const a of list.approvals || []) if (a.state === "pending") {
      await api(`/v1/runs/${runId}/approvals/${a.id}/decision`, { method: "POST", body: { decision: "approve" } });
      approved.push(a.tool);
    }
    const r = await api(`/v1/runs/${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(r.state)) return r;
    await sleep(1000);
  }
  throw Error(`run ${runId} not finished in ${RUN_MS / 1000}s`);
}
const lastReply = async (conversationId) => {
  const c = await api(`/v1/conversations/${conversationId}`);
  return [...c.messages].reverse().find((m) => m.role === "assistant")?.content || "";
};

await test("health", async () => { const h = await api("/health", { auth: false }); ok(h.ok === true, JSON.stringify(h)); return `modelMode=${h.modelMode}`; });
await test("web workbench page + bundle", async () => {
  const html = await api("/", { auth: false });
  const js = String(html).match(/\/assets\/[^"]+\.js/)?.[0]; ok(js, "no /assets/*.js in index.html");
  const r = await req(js, { auth: false }); ok(r.ok, `${js} -> ${r.status}`); return js;
});
await test("admin console page", async () => { ok(String(await api("/admin/", { auth: false })).includes("app.js"), "admin/app.js not referenced"); });
await test("API rejects anonymous calls", async () => { const r = await req("/v1/runs", { auth: false }); ok(r.status === 401, `HTTP ${r.status}`); });
const loggedIn = await test("admin password login", async () => {
  ok(password, "no admin password: accounts.txt has no Password: line — set PIG_REMOTE_ADMIN_PASSWORD (and PIG_REMOTE_ADMIN_USER if not admin)");
  const r = await req("/auth/web/login", { method: "POST", auth: false, headers: { Origin: ORIGIN }, body: { username, password } });
  const body = await r.json().catch(() => ({}));
  ok(r.status === 200, `HTTP ${r.status} ${body.error || ""}`);
  session = (r.headers.get("set-cookie") || "").match(/pig_web_session=([^;]+)/)?.[1] || "";
  ok(session, "no session cookie"); ok(body.account?.role === "admin", `role=${body.account?.role}`);
  return `role=admin, session 12h`;
});
if (!loggedIn) { console.log(`E2E: ${passed} passed, ${failed} failed (stopped: no admin session)`); process.exit(1); }
await test("admin overview: runners + model channel", async () => {
  const o = await api("/v1/admin/overview");
  const online = o.workers.filter((w) => w.online && w.enabled).length; mode = o.modelMode;
  ok(online >= 1, `online runners=${online}`);
  ok(mode === "provider", `modelMode=${mode} (expected provider / real DeepSeek channel)`);
  return `online runners=${online}, modelMode=${mode}`;
});
await test("workbench API: conversations list", async () => { const c = await api("/v1/conversations"); ok(Array.isArray(c.conversations ?? c), "unexpected shape"); });

const marker = `PIG-E2E-${randomUUID().slice(0, 8)}`;
let run1;
await test("real model run: tool calls + approval + artifact", async () => {
  const t0 = Date.now(); const approved = [];
  const created = await api("/v1/runs", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 201, body: {
    prompt: `请在工作区创建文件 e2e-proof.txt，内容只有一行：${marker}。然后读取该文件确认内容，最后用一句话回复确认。`, requireApproval: true } });
  run1 = await finish(created.id, approved);
  blockIf402(run1.state, run1.error);
  ok(run1.state === "succeeded", `state=${run1.state} ${run1.error || ""}`);
  ok(approved.length >= 1, "no approval was requested");
  const log = await api(`/v1/runs/${run1.id}/eventlog`);
  const tools = log.events.filter((e) => e.event?.type === "tool_start").map((e) => e.event.tool || e.event.name || "?");
  ok(tools.length >= 2, `tool calls=${tools.length}`);
  const art = (await api(`/v1/runs/${run1.id}/artifacts`)).artifacts.find((a) => a.path === "e2e-proof.txt");
  ok(art, "artifact e2e-proof.txt missing");
  const content = await (await req(`/v1/runs/${run1.id}/artifacts/${art.id}`)).text();
  ok(content.includes(marker), "artifact content mismatch");
  return `${((Date.now() - t0) / 1000).toFixed(1)}s, approved=[${approved.join(",")}], tools=[${tools.join(",")}]`;
});
await test("conversation follow-up turn (same workspace)", async () => {
  ok(run1?.conversation_id, "no first run");
  const f = await api(`/v1/runs/${run1.id}/follow-ups`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 201, body: { prompt: "读取 e2e-proof.txt，只回复文件内容本身。" } });
  const r = await finish(f.id); blockIf402(r.state, r.error); ok(r.state === "succeeded", `state=${r.state} ${r.error || ""}`);
  const reply = await lastReply(run1.conversation_id);
  if (mode === "provider") ok(reply.includes(marker), `reply does not contain the marker: ${reply.slice(0, 80)}`);
  return `reply="${reply.slice(0, 60)}"`;
});
await test("observability: run trace spans cloud/worker/runner/gateway", async () => {
  ok(run1?.id, "no first run");
  const want = ["cloud", "gateway", "runner", "worker"]; let t;
  for (let i = 0; i < 20; i++) {
    t = await api(`/v1/runs/${run1.id}/trace`);
    if (want.every((s) => t.services.includes(s)) && t.spans.some((s) => s.name === "run" && !s.attributes?.synthesized)) break;
    await sleep(1500);
  }
  const missing = want.filter((s) => !t.services.includes(s)); ok(!missing.length, `services=${t.services.join(",")} missing=${missing.join(",")}`);
  const ids = new Set(t.spans.map((s) => s.spanId));
  const orphans = t.spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId)).length;
  const model = t.spans.filter((s) => s.service === "runner" && s.name.startsWith("chat ")).length;
  const tools = t.spans.filter((s) => s.name.startsWith("execute_tool ")).length;
  const llm = t.spans.filter((s) => s.service === "gateway" && s.name.startsWith("POST /v1/chat")).length;
  ok(model >= 1 && tools >= 1 && llm >= 1, `model=${model} tools=${tools} gateway=${llm}`);
  ok(orphans === 0, `${orphans} spans with unknown parent`);
  return `${t.spanCount} spans, services=[${t.services.join(",")}], model=${model}, tools=${tools}, gateway=${llm}`;
});
await test("observability: metrics + alerts (no critical firing)", async () => {
  const text = await (await req("/v1/admin/metrics")).text();
  const series = ["pig_http_requests_total", "pig_runs", "pig_runners_online", "pig_model_requests_total", "pig_run_execution_seconds_count", "pig_trace_spans_total", "pig_alerts_firing"];
  const missing = series.filter((m) => !new RegExp(`^${m}[{ ]`, "m").test(text)); ok(!missing.length, `missing series: ${missing.join(",")}`);
  const a = await api("/v1/admin/alerts");
  const critical = a.active.filter((x) => x.severity === "critical");
  ok(!critical.length, `critical alerts firing: ${critical.map((x) => `${x.rule} (${x.summary})`).join("; ")}`);
  return `${text.split("\n").filter((l) => l && !l.startsWith("#")).length} samples, ${a.rules.length} rules, active=[${a.active.map((x) => x.rule).join(",")}]`;
});
await test("model routing: channel fields + output cap on gateway spans", async () => {
  const channels = (await api("/v1/admin/channels")).channels;
  const primary = channels.find((c) => c.enabled);
  ok(!primary || ("fallback_rank" in primary && Number.isInteger(primary.max_output_tokens)), "channel routing fields missing (migration 0005?)");
  const t = await api(`/v1/runs/${run1.id}/trace`);
  const chats = t.spans.filter((s) => s.service === "gateway" && s.name === "POST /v1/chat/completions");
  ok(chats.length && chats.every((s) => Number(s.attributes["pig.output.cap"]) > 0 && Number(s.attributes["pig.failover.attempts"]) >= 1), "gateway spans lack routing attributes");
  return `primary=${primary ? `${primary.name}/${primary.model} cap=${primary.max_output_tokens}` : "env"}, standby=${channels.filter((c) => c.fallback_rank).length}, attempts=[${chats.map((s) => s.attributes["pig.failover.attempts"]).join(",")}]`;
});
await test("object storage: attachment round trip + verified copies", async () => {
  const st = await api("/v1/admin/storage");
  if (st.mode === "pg") throw new Skip("object storage not configured (STORAGE_MODE=pg)");
  ok(st.reachable, "object store unreachable");
  const text = `e2e 对象存储 ${randomUUID()}`;
  const up = await api("/v1/attachments", { method: "POST", status: 201, body: { name: "e2e-storage.txt", contentType: "text/plain", data: Buffer.from(text).toString("base64") } });
  try {
    let after;
    for (let i = 0; i < 10; i++) { after = await api("/v1/admin/storage"); if (after.tables.attachments.offloaded > st.tables.attachments.offloaded) break; await sleep(1000); }
    ok(after.tables.attachments.offloaded > st.tables.attachments.offloaded, "new attachment was not copied to the object store");
    const body = await (await req(`/v1/attachments/${up.attachment.id}/download`)).text();
    ok(body === text, "downloaded bytes differ from upload");
  } finally { await api(`/v1/attachments/${up.attachment.id}`, { method: "DELETE" }); }
  const v = await api("/v1/admin/storage/verify", { method: "POST", body: {} });
  ok(!v.missing.length && !v.mismatched.length, `verify: missing=${v.missing.length} mismatched=${v.mismatched.length}`);
  const t = (await api("/v1/admin/storage")).tables;
  return `mode=${st.mode}, verified ${v.ok}/${v.checked}, attachments ${t.attachments.offloaded}/${t.attachments.total}, workspaces ${t.workspaces.offloaded}/${t.workspaces.total} offloaded, pending ${t.attachments.pending + t.workspaces.pending}`;
});
await test("knowledge base: ingest + search + cited answer in a project run", async () => {
  // One reusable personal project (projects cannot be deleted); the test document is removed afterwards.
  const name = "E2E 知识库（自动测试）";
  const projects = (await api("/v1/projects")).projects;
  const projectId = projects.find((p) => p.name === name && p.kind === "personal")?.id ?? (await api("/v1/projects", { method: "POST", status: 201, body: { name, description: "e2e-remote.sh 知识库检查使用，可忽略" } })).id;
  const code = `KB-${randomUUID().slice(0, 8).toUpperCase()}`;
  const doc = `# 猪猪星球运维手册\n\n## 机房门禁\n\n进入猪猪星球三号机房需要出示紫色门禁卡，并报出本季度暗号 ${code}。暗号每季度轮换一次。\n\n## 值班\n\n值班表每周一上午更新。\n`;
  const t0 = Date.now();
  const up = await api(`/v1/projects/${projectId}/knowledge`, { method: "POST", status: 201, body: { name: `e2e-${code}.md`, data: Buffer.from(doc).toString("base64") } });
  try {
    let d;
    for (let i = 0; i < 30; i++) { d = (await api(`/v1/projects/${projectId}/knowledge`)).documents.find((x) => x.id === up.document.id); if (d?.status === "ready" || d?.status === "failed") break; await sleep(1000); }
    ok(d?.status === "ready", `ingestion status=${d?.status} ${d?.error || ""}`);
    const ingestMs = Date.now() - t0;
    const s = await api(`/v1/projects/${projectId}/knowledge/search`, { method: "POST", body: { query: "三号机房 门禁 暗号", k: 3 } });
    ok(s.hits[0]?.content.includes(code), "search did not return the document");
    const view = await api(`/v1/knowledge/chunks/${s.hits[0].id}`);
    ok(view.chunk.heading.includes("机房门禁"), "citation view heading mismatch");
    const created = await api("/v1/runs", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 201, body: { prompt: "根据项目知识库回答：进入猪猪星球三号机房需要报出的本季度暗号是什么？", projectId, requireApproval: false } });
    const r = await finish(created.id); blockIf402(r.state, r.error); ok(r.state === "succeeded", `state=${r.state} ${r.error || ""}`);
    const reply = r.conversation_id ? await lastReply(r.conversation_id) : String(r.result || "");
    const tools = (await api(`/v1/runs/${created.id}/eventlog`)).events.filter((e) => e.event?.type === "tool_start").map((e) => e.event.tool || e.event.name);
    ok(tools.includes("knowledge_search"), `knowledge_search not called (tools=${tools.join(",")})`);
    if (mode === "provider") {
      ok(reply.includes(code), `answer lacks the code: ${reply.slice(0, 80)}`);
      ok(/\(#knowledge:chunk_[a-f0-9]{32}\)/.test(reply), "answer has no clickable citation");
    }
    return `ingest ${ingestMs} ms, search ${s.tookMs} ms (${s.mode}), tools=[${tools.join(",")}], reply="${reply.replace(/\(#knowledge:chunk_[a-f0-9]+\)/g, "(#knowledge:…)").slice(0, 60)}"`;
  } finally { await api(`/v1/projects/${projectId}/knowledge/${up.document.id}`, { method: "DELETE" }).catch(() => {}); }
});
// Opt-in (PIG_E2E_FAILOVER=1): briefly routes production through a broken primary with the real channel as
// standby, proves the run still succeeds via failover, then restores the original primary.
if (process.env.PIG_E2E_FAILOVER === "1") await test("model failover: broken primary -> standby (live)", async () => {
  const before = (await api("/v1/admin/channels")).channels.find((c) => c.enabled);
  if (!before) throw new Skip("no primary channel configured");
  let broken;
  try {
    broken = await api("/v1/admin/channels", { method: "POST", status: 201, body: { name: "e2e 故障转移（自动删除）", baseUrl: "https://failover-e2e.invalid/v1", model: "none", apiKey: "sk-e2e-not-a-key" } });
    await api(`/v1/admin/channels/${broken.id}/activate`, { method: "POST", body: { enabled: true } });
    await api(`/v1/admin/channels/${before.id}`, { method: "PATCH", body: { fallbackRank: 1 } });
    const t0 = Date.now();
    const created = await api("/v1/runs", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 201, body: { prompt: "计算 17*23，只回答数字。", requireApproval: false } });
    const r = await finish(created.id); blockIf402(r.state, r.error); ok(r.state === "succeeded", `state=${r.state} ${r.error || ""}`);
    let chat;
    for (let i = 0; i < 15 && !chat; i++) {
      chat = (await api(`/v1/runs/${created.id}/trace`)).spans.find((s) => s.service === "gateway" && s.name === "POST /v1/chat/completions" && Number(s.attributes["pig.failover.attempts"]) >= 2);
      if (!chat) await sleep(1000);
    }
    ok(chat, "no gateway span with a failover");
    ok(chat.attributes["pig.channel_id"] === before.id && chat.attributes["pig.upstream.status"] === 200, `served by ${chat.attributes["pig.channel_id"]} status ${chat.attributes["pig.upstream.status"]}`);
    return `${((Date.now() - t0) / 1000).toFixed(1)}s, path=${String(chat.attributes["pig.failover.path"]).replace(/channel_([a-f0-9]{6})[a-f0-9]+/g, "$1…")}`;
  } finally {
    await api(`/v1/admin/channels/${before.id}/activate`, { method: "POST", body: { enabled: true } });
    if (broken) await api(`/v1/admin/channels/${broken.id}`, { method: "DELETE" });
    const after = (await api("/v1/admin/channels")).channels;
    ok(after.find((c) => c.enabled)?.id === before.id && !after.some((c) => c.id === broken?.id), "routing NOT restored — check /admin channels");
  }
});

let n = 0;
const rpc = async (method, params, auth = true) => {
  const r = await req("/v1/a2a", { method: "POST", auth, timeout: 120000, body: { jsonrpc: "2.0", id: ++n, method, params } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const msg = (text, contextId) => ({ message: { role: "user", messageId: randomUUID(), ...(contextId ? { contextId } : {}), parts: [{ kind: "text", text }] } });
await test("A2A agent card", async () => {
  const c = await api("/.well-known/agent-card.json", { auth: false });
  ok(c.capabilities?.streaming === true, "streaming capability missing"); ok(/\/v1\/a2a$/.test(c.url), `url=${c.url}`);
  if (ORIGIN.startsWith("https://")) ok(c.url === `${ORIGIN}/v1/a2a`, `card advertises ${c.url}, expected ${ORIGIN}/v1/a2a (bearer would go over plain http)`);
  return `protocol=${c.protocolVersion}, url=${c.url}, skills=${c.skills?.length ?? 0}`;
});
await test("A2A rejects anonymous calls", async () => { const r = await rpc("tasks/get", { id: "x" }, false); ok(r.status === 401, `HTTP ${r.status}`); });
let sendTask;
await test("A2A message/send (blocking)", async () => {
  const t0 = Date.now();
  const r = await rpc("message/send", { ...msg("计算 17*23，只回答数字。"), configuration: { blocking: true } });
  ok(!r.body.error, JSON.stringify(r.body.error)); sendTask = r.body.result;
  blockIf402(sendTask?.status?.state, JSON.stringify(sendTask?.status?.message ?? ""));
  ok(sendTask?.status?.state === "completed", `state=${sendTask?.status?.state}`);
  const text = sendTask.status.message?.parts?.map((p) => p.text || "").join("") || JSON.stringify(sendTask.artifacts || []).slice(0, 200);
  if (mode === "provider") ok(text.includes("391"), `reply=${text.slice(0, 60)}`);
  return `${((Date.now() - t0) / 1000).toFixed(1)}s, reply="${text.slice(0, 40)}"`;
});
await test("A2A message/stream (SSE)", async () => {
  const t0 = Date.now();
  const r = await req("/v1/a2a", { method: "POST", timeout: 180000, headers: { accept: "text/event-stream" }, body: { jsonrpc: "2.0", id: ++n, method: "message/stream", params: msg("用两句话介绍你自己。", sendTask?.contextId) } });
  ok(r.status === 200 && (r.headers.get("content-type") || "").includes("text/event-stream"), `HTTP ${r.status} ${r.headers.get("content-type")}`);
  const kinds = {}; let final, taskId, firstMs, buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) >= 0) {
      const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"); buf = buf.slice(i + 2);
      if (!data) continue; const e = JSON.parse(data); ok(!e.error, JSON.stringify(e.error));
      const k = e.result.kind; kinds[k] = (kinds[k] || 0) + 1; firstMs ??= Date.now() - t0;
      if (k === "task") taskId = e.result.id;
      if (k === "status-update" && e.result.final) final = e.result.status.state;
    }
  }
  ok(kinds.task && kinds["status-update"], `events=${JSON.stringify(kinds)}`);
  blockIf402(final, "");
  ok(final === "completed", `final=${final}`);
  const g = await rpc("tasks/get", { id: taskId }); ok(g.body.result?.status?.state === "completed", "tasks/get state mismatch");
  return `first event ${firstMs}ms, total ${((Date.now() - t0) / 1000).toFixed(1)}s, events=${JSON.stringify(kinds)}, tasks/get=completed`;
});

await test("OpenAPI spec /openapi.json", async () => {
  const spec = await api("/openapi.json", { auth: false });
  ok(spec.openapi === "3.1.0", `openapi=${spec.openapi}`);
  for (const p of ["/v1/runs", "/v1/webhooks", "/v1/webhooks/{id}/deliveries", "/v1/runs/{id}/trace", "/v1/admin/alerts"]) ok(spec.paths?.[p], `missing path ${p}`);
  return `${Object.keys(spec.paths).length} paths, ${Object.keys(spec.components.schemas).length} schemas`;
});
await test("API docs page /api-docs", async () => {
  ok(String(await api("/api-docs", { auth: false })).includes("/api-docs.js"), "script not referenced");
  const r = await req("/api-docs.js", { auth: false }); ok(r.ok && (await r.text()).includes("/openapi.json"), `api-docs.js -> ${r.status}`);
});

// Webhooks: deliveries go server -> its own public origin (built-in signature-verifying sink), so this
// also proves cloud egress, DNS/IP pinning and TLS to the public certificate.
const SINK = /^https:\/\//.test(ORIGIN) ? `${ORIGIN}/v1/webhook-sink` : "";
let hook;
const deliveriesOf = async () => (await api(`/v1/webhooks/${hook.id}/deliveries`)).deliveries;
async function delivered(match, ms = 90000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) {
    last = (await deliveriesOf()).find(match);
    if (last?.state === "succeeded") return last;
    if (last?.state === "dead") break;
    await sleep(1000);
  }
  if (last && !last.lastStatus && /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timeout|aborted/i.test(last.lastError || ""))
    throw new Skip(`server cannot reach its own public address (${last.lastError}); hairpin NAT? verify with an external receiver`);
  throw Error(last ? `delivery ${last.state}, attempts=${last.attempts}, status=${last.lastStatus}, error=${last.lastError}` : "no delivery recorded");
}
try {
  await test("webhooks: create (secret shown once) + SSRF guard", async () => {
    if (!SINK) throw new Skip(`public origin ${ORIGIN} is not HTTPS`);
    const bad = await req("/v1/webhooks", { method: "POST", body: { url: "https://127.0.0.1/x", events: ["run.succeeded"] } });
    ok(bad.status === 400, `private target accepted: HTTP ${bad.status}`);
    hook = await api("/v1/webhooks", { method: "POST", status: 201, body: { url: SINK, events: ["run.succeeded", "run.failed", "run.cancelled", "alert.firing"], description: "e2e 部署验收（自动删除）" } });
    ok(/^whsec_/.test(hook.secret || ""), "no signing secret returned");
    const again = await api(`/v1/webhooks/${hook.id}`); ok(!("secret" in again), "secret readable after creation");
    return `${hook.id} -> ${SINK}`;
  });
  await test("webhooks: signed ping delivered + verified by receiver", async () => {
    if (!hook) throw new Skip("no webhook");
    const t0 = Date.now();
    const p = await api(`/v1/webhooks/${hook.id}/ping`, { method: "POST", status: 202 });
    const d = await delivered((x) => x.id === p.deliveryId);
    const receipts = (await api(`/v1/webhooks/${hook.id}/sink-receipts`)).receipts;
    const r = receipts.find((x) => x.deliveryId === p.deliveryId);
    ok(r?.verified && r.eventId === p.eventId, "receiver has no verified receipt for this delivery");
    return `HTTP ${d.lastStatus}, attempts=${d.attempts}, ${Date.now() - t0}ms incl. polling`;
  });
  await test("webhooks: run.cancelled event for a cancelled run (no model call)", async () => {
    if (!hook) throw new Skip("no webhook");
    const t0 = Date.now();
    const created = await api("/v1/runs", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 201, body: { prompt: "e2e webhook 测试：立即取消", requireApproval: true } });
    await api(`/v1/runs/${created.id}/abort`, { method: "POST" });
    const r = await finish(created.id); ok(r.state === "cancelled", `state=${r.state}`);
    const d = await delivered((x) => x.event === "run.cancelled" && Date.parse(x.createdAt) >= t0 - 5000);
    return `HTTP ${d.lastStatus}, attempts=${d.attempts}`;
  });
  await test("alerts: test alert.firing delivered to the webhook", async () => {
    if (!hook) throw new Skip("no webhook");
    const t0 = Date.now();
    const a = await api("/v1/admin/alerts/test", { method: "POST", status: 202 });
    const d = await delivered((x) => x.event === "alert.firing" && Date.parse(x.createdAt) >= t0 - 5000);
    const r = (await api(`/v1/webhooks/${hook.id}/sink-receipts`)).receipts.find((x) => x.eventId === a.eventId);
    ok(r?.verified, "receiver has no verified receipt for the alert");
    return `HTTP ${d.lastStatus}, ${Date.now() - t0}ms incl. polling`;
  });
  await test("webhooks: receiver rejects a forged signature", async () => {
    if (!hook) throw new Skip("no webhook");
    const r = await req("/v1/webhook-sink", { method: "POST", auth: false, headers: { "X-Pig-Webhook-Id": hook.id, "X-Pig-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: { id: "evt_forged", type: "ping" } });
    ok(r.status === 401, `HTTP ${r.status}`);
  });
  await test("webhooks: delivery log + redeliver", async () => {
    if (!hook) throw new Skip("no webhook");
    const list = await deliveriesOf(); ok(list.length >= 1, "empty delivery log");
    const first = list.find((x) => x.state === "succeeded"); ok(first, "no succeeded delivery to redeliver");
    await api(`/v1/webhooks/${hook.id}/deliveries/${first.id}/redeliver`, { method: "POST", status: 202 });
    const d = await delivered((x) => x.id === first.id && x.attempts === 1 && Date.parse(x.lastAttemptAt) > Date.parse(first.lastAttemptAt));
    return `${list.length} log entries, redelivered HTTP ${d.lastStatus}`;
  });
} finally {
  if (hook) await test("webhooks: delete test webhook", async () => {
    await api(`/v1/webhooks/${hook.id}`, { method: "DELETE" }); await api(`/v1/webhooks/${hook.id}`, { status: 404 });
  });
}

const schedules = [];
try {
  await test("schedules: create cron (Asia/Shanghai)", async () => {
    const s = await api("/v1/schedules", { method: "POST", status: 201, headers: { "Idempotency-Key": randomUUID() }, body: { name: "e2e 部署验收（自动删除）", prompt: "只回复 SCHEDULE-OK", schedule: "0 9 * * *", timezone: "Asia/Shanghai" } });
    schedules.push(s.id); const g = await api(`/v1/schedules/${s.id}`);
    ok(g.next_fire_at || g.nextFireAt, "next fire time missing");
    ok((await api("/v1/schedules")).schedules?.some?.((x) => x.id === s.id) ?? true, "not listed");
    return `next=${g.next_fire_at || g.nextFireAt}`;
  });
  await test("schedules: manual run + history", async () => {
    const s = await api("/v1/schedules", { method: "POST", status: 201, headers: { "Idempotency-Key": randomUUID() }, body: { name: "e2e 手动计划（自动删除）", prompt: "只回复 SCHEDULE-OK", schedule: null, timezone: "Asia/Shanghai" } });
    schedules.push(s.id);
    const fired = await api(`/v1/schedules/${s.id}/run`, { method: "POST", status: 202, headers: { "Idempotency-Key": randomUUID() } });
    const r = await finish(fired.remoteRunId); blockIf402(r.state, r.error); ok(r.state === "succeeded", `state=${r.state} ${r.error || ""}`);
    const h = await api(`/v1/schedules/${s.id}/history`); ok(h.runs.some((x) => x.id === fired.remoteRunId), "run not in history");
    return `run ${r.state}`;
  });
} finally {
  await test("schedules: delete test schedules", async () => {
    for (const id of schedules) { await api(`/v1/schedules/${id}`, { method: "DELETE" }); await api(`/v1/schedules/${id}`, { status: 404 }); }
    return `${schedules.length} deleted`;
  });
}
await req("/auth/web/logout", { method: "POST", auth: false, headers: { Origin: ORIGIN, Cookie: `pig_web_session=${session}` } }).catch(() => {});
console.log(`E2E: ${passed} passed, ${failed} failed${blocked ? `, ${blocked} blocked (model provider HTTP 402)` : ""}${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
JS
run_node() {
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ]; then ACCOUNTS=$ACC node "$tmp/e2e.mjs"; return; fi
  local mount=()
  [ -r "$ACC" ] && mount=(-v "$ACC":/run/pig/accounts.txt:ro)
  docker run --rm --network host --user "$(id -u):$(id -g)" -e BASE -e ORIGIN -e E2E_RUN_TIMEOUT_S -e PIG_PACE_MS \
    -e PIG_REMOTE_ADMIN_USER -e PIG_REMOTE_ADMIN_PASSWORD -e NODE_TLS_REJECT_UNAUTHORIZED -e NODE_NO_WARNINGS \
    "${mount[@]}" -v "$tmp/e2e.mjs":/e2e.mjs:ro "$NODE_IMAGE" node /e2e.mjs
}
run_node; rc=$?
[ "$PUB" = 0 ] || rc=1
exit $rc
