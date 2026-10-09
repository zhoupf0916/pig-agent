// F3 Feishu bot against the local cloud stack (mock model), with a fake Feishu transport:
// bind via one-time code, DM + group @mention, dedupe, approval notice, final reply, follow-up,
// /new, /unbind, and no leftover in-process sessions. Run: pnpm exec tsx scripts/smoke-cloud-feishu.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync("data/cloud-local/stack.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ip = execFileSync("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", "pig-agent-cloud-postgres-1"], { encoding: "utf8" }).trim().split(" ")[0];
process.env.DATABASE_URL = `postgres://pig:${env.DB_PASSWORD}@${ip}:5432/pig`;
const base = "http://127.0.0.1:8890";
const { handleEvent, pumpReplies, inProcessApi, createBindCode } = await import("../apps/cloud/src/feishu/service.ts");
const { db } = await import("../apps/cloud/src/db.ts");
const replies: Array<[string, string]> = [];
const deps = {
  transport: { reply: async (id: string, text: string) => void replies.push([id, text]) },
  api: inProcessApi((path, init) => fetch(base + path, init)),
  botOpenId: () => "ou_bot",
  origin: () => "https://pig.example",
};
const member = async (path: string, init: RequestInit = {}) => (await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${env.MEMBER_TOKEN}`, "content-type": "application/json", "Idempotency-Key": randomUUID(), ...(init.headers ?? {}) } })).json();
const me = await member("/v1/me");
const openId = "ou_smoke_" + randomUUID().slice(0, 8);
const dm = "oc_dm_" + randomUUID().slice(0, 8);
let n = 0;
const ev = (text: string, opts: { group?: boolean; mention?: string } = {}) => ({
  sender: { sender_id: { open_id: openId }, sender_type: "user" },
  message: {
    message_id: `om_${randomUUID()}`, chat_id: opts.group ? "oc_group" : dm, chat_type: opts.group ? "group" : "p2p", message_type: "text",
    content: JSON.stringify({ text: opts.mention ? `@_user_1 ${text}` : text }),
    mentions: opts.mention ? [{ key: "@_user_1", id: { open_id: opts.mention }, name: "猪猪" }] : [],
  },
});
const lastReply = () => replies.at(-1)?.[1] ?? "";
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 200 && !pred(); i++) { await pumpReplies(deps); await new Promise((r) => setTimeout(r, 250)); }
  assert.ok(pred(), what);
}
try {
  const status = await member("/v1/feishu");
  assert.equal(status.enabled, false, "flag must be off without FEISHU_APP_ID");
  assert.equal((await fetch(base + "/v1/feishu/bind-code", { method: "POST", headers: { Authorization: `Bearer ${env.MEMBER_TOKEN}` } })).status, 404);

  assert.equal(await handleEvent(ev("你好"), deps), "unbound");
  assert.match(lastReply(), /还没有绑定/);
  assert.equal(await handleEvent(ev("/bind ZZZZZZZZ"), deps), "bind");
  assert.match(lastReply(), /无效或已过期/);
  const { code } = await createBindCode(me.id);
  assert.equal(await handleEvent(ev(`/bind ${code}`, { group: true, mention: "ou_bot" }), deps), "bind-in-group");
  await handleEvent(ev(`/bind ${code.toLowerCase().slice(0, 4)}-${code.slice(4)}`), deps);
  assert.match(lastReply(), /已绑定工作台账号/);
  assert.equal(await handleEvent(ev(`/bind ${code}`), deps), "bind");
  assert.match(lastReply(), /无效或已过期/, "a bind code must be single-use");
  assert.equal((await member("/v1/feishu")).bound, true);

  assert.match(await handleEvent(ev("这条不该触发", { group: true }), deps), /^ignored/);
  assert.match(await handleEvent(ev("这条 @ 的是别人", { group: true, mention: "ou_someone" }), deps), /^ignored/);

  // DM task with approval: notice first, then the final reply after approval.
  const e1 = ev("Approval success acceptance");
  const r1 = await handleEvent(e1, deps);
  assert.match(r1, /^run /);
  assert.equal(await handleEvent(e1, deps), "duplicate");
  const run1 = r1.slice(4);
  await until(() => replies.some(([id, t]) => id === e1.message.message_id && /确认一个操作/.test(t)), "no approval notice");
  const pending = (await member(`/v1/runs/${run1}/approvals`)).approvals.find((a: { state: string }) => a.state === "pending");
  await member(`/v1/runs/${run1}/approvals/${pending.id}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  await until(() => replies.filter(([id]) => id === e1.message.message_id).length >= 2, "no final reply");
  const final = replies.filter(([id]) => id === e1.message.message_id).at(-1)![1];
  assert.match(final, /在工作台查看：https:\/\/pig\.example\/#\/conversations\/conv_/);
  assert.doesNotMatch(final, /^任务失败/);
  if (process.env.SHOW) console.log("final reply:", JSON.stringify(final));

  // Follow-up continues the same conversation; /new starts a new one.
  const conv1 = (await member(`/v1/runs/${run1}`)).conversation_id;
  const r2 = (await handleEvent(ev("继续"), deps)).slice(4);
  assert.equal((await member(`/v1/runs/${r2}`)).conversation_id, conv1, "follow-up did not continue the conversation");
  await member(`/v1/runs/${r2}/abort`, { method: "POST", body: "{}" }).catch(() => {});
  assert.equal(await handleEvent(ev("/new"), deps), "new");
  const r3 = (await handleEvent(ev("新话题", { group: true, mention: "ou_bot" }), deps)).slice(4);
  assert.notEqual((await member(`/v1/runs/${r3}`)).conversation_id, conv1);
  await member(`/v1/runs/${r3}/abort`, { method: "POST", body: "{}" }).catch(() => {});

  const leaked = await db.query("SELECT count(*)::int AS n FROM auth_sessions WHERE id LIKE 'fs\\_%'");
  assert.equal(leaked.rows[0].n, 0, "in-process sessions were not cleaned up");
  assert.equal(await handleEvent(ev("/unbind"), deps), "unbind");
  assert.equal((await member("/v1/feishu")).bound, false);
  console.log(`PASS feishu bot (fake transport): bind single-use, group @-only, dedupe, approval notice + final reply, follow-up, /new, /unbind; ${replies.length} replies`);
} finally {
  await db.query("DELETE FROM feishu_bindings WHERE open_id=$1", [openId]).catch(() => {});
  await db.end();
}
