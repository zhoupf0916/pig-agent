// F3 Feishu bot core. Transport-agnostic: the SDK long connection (client.ts) feeds events in and
// sends replies out; everything else goes through the public API as the bound principal, so quotas,
// policies and approvals behave exactly as in the workbench.
import { randomBytes, randomUUID } from "node:crypto";
import { db, hash } from "../db.ts";
import { bindCode, chatKey, finalReply, HELP_TEXT, normalizeCode, parseIncoming, type FeishuMessageEvent } from "./text.ts";

export type Transport = { reply(messageId: string, text: string): Promise<void> };
export type Api = (principalId: string, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
export type FeishuDeps = { transport: Transport; api: Api; botOpenId: () => string | undefined; origin: () => string | undefined };

const BIND_TTL_MINUTES = 10;
const REPLY_TIMEOUT_MINUTES = 60;
const failedBinds = new Map<string, number[]>();

export function feishuEnabled(env = process.env) {
  return !!env.FEISHU_APP_ID && !!env.FEISHU_APP_SECRET && env.FEISHU_ENABLED !== "0";
}

export async function createBindCode(principalId: string) {
  const code = bindCode(randomBytes(8));
  await db.query("DELETE FROM feishu_bind_codes WHERE principal_id=$1 OR expires_at<now()-interval '1 day'", [principalId]);
  await db.query(`INSERT INTO feishu_bind_codes(code_hash,principal_id,expires_at) VALUES($1,$2,now()+make_interval(mins=>$3))`, [hash(code), principalId, BIND_TTL_MINUTES]);
  return { code, expiresInSeconds: BIND_TTL_MINUTES * 60 };
}

async function bind(openId: string, arg: string): Promise<string> {
  const now = Date.now();
  const recent = (failedBinds.get(openId) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 5) return "绑定失败次数过多，请 10 分钟后再试。";
  const code = normalizeCode(arg);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "UPDATE feishu_bind_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING principal_id",
      [hash(code)],
    );
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      failedBinds.set(openId, [...recent, now]);
      return "绑定码无效或已过期。请在工作台「设置 → 飞书」重新生成，然后发送 /bind 绑定码。";
    }
    const principalId = found.rows[0].principal_id as string;
    // One Feishu identity per account and one account per identity: rebinding replaces the old pair.
    await client.query("DELETE FROM feishu_bindings WHERE principal_id=$1 OR open_id=$2", [principalId, openId]);
    await client.query("INSERT INTO feishu_bindings(open_id,principal_id) VALUES($1,$2)", [openId, principalId]);
    await client.query("COMMIT");
    const who = await db.query("SELECT name FROM principals WHERE id=$1", [principalId]);
    return `已绑定工作台账号「${who.rows[0]?.name ?? principalId}」。现在可以私聊我，或在群里 @我 发任务。`;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function principalFor(openId: string) {
  const r = await db.query("SELECT b.principal_id FROM feishu_bindings b JOIN principals p ON p.id=b.principal_id WHERE b.open_id=$1 AND p.enabled", [openId]);
  return r.rows[0]?.principal_id as string | undefined;
}

function link(deps: FeishuDeps, conversationId: string | null | undefined) {
  const origin = deps.origin();
  return origin && conversationId ? `${origin}/#/conversations/${conversationId}` : origin;
}

/** Handle one im.message.receive_v1 event. Returns what happened (for logs and tests). */
export async function handleEvent(event: FeishuMessageEvent, deps: FeishuDeps): Promise<string> {
  const msg = parseIncoming(event, deps.botOpenId());
  if (msg.kind === "ignore") return "ignored: " + msg.reason;
  // Feishu redelivers on slow acks; process each message once.
  const fresh = await db.query("INSERT INTO feishu_messages(message_id) VALUES($1) ON CONFLICT DO NOTHING", [msg.messageId]);
  if (!fresh.rowCount) return "duplicate";
  const say = (text: string) => deps.transport.reply(msg.messageId, text);
  if (msg.kind === "unsupported") return await say("目前只支持文字消息。"), "unsupported";
  if (msg.kind === "command" && msg.command === "help") return await say(HELP_TEXT), "help";
  if (msg.kind === "command" && msg.command === "bind") {
    if (msg.group) return await say("为保护绑定码，请私聊我发送 /bind 绑定码。"), "bind-in-group";
    return await say(await bind(msg.openId, msg.arg)), "bind";
  }
  const principalId = await principalFor(msg.openId);
  if (!principalId) return await say("你还没有绑定工作台账号。\n" + HELP_TEXT), "unbound";
  const key = chatKey(msg.chatId, msg.openId, msg.group);
  if (msg.kind === "command" && msg.command === "unbind") {
    await db.query("DELETE FROM feishu_bindings WHERE open_id=$1", [msg.openId]);
    await db.query("DELETE FROM feishu_chats WHERE principal_id=$1", [principalId]);
    return await say("已解除绑定。"), "unbind";
  }
  if (msg.kind === "command" && msg.command === "new") {
    await db.query("DELETE FROM feishu_chats WHERE chat_key=$1", [key]);
    return await say("好的，下一条消息会开始新会话。"), "new";
  }
  if (msg.kind !== "prompt") return "ignored";
  const chat = await db.query("SELECT last_run_id FROM feishu_chats WHERE chat_key=$1 AND principal_id=$2", [key, principalId]);
  const last = chat.rows[0]?.last_run_id as string | undefined;
  let created = last
    ? await deps.api(principalId, "POST", `/v1/runs/${last}/follow-ups`, { prompt: msg.text })
    : undefined;
  // The previous conversation may be gone, busy or not continuable: start a fresh one instead.
  if (!created || created.status !== 201) created = await deps.api(principalId, "POST", "/v1/runs", { prompt: msg.text, requireApproval: true });
  if (created.status !== 201) return await say(`没能创建任务：${created.json?.error || "HTTP " + created.status}`), "create-failed";
  const runId = created.json.id as string;
  await db.query(
    `INSERT INTO feishu_chats(chat_key,principal_id,last_run_id) VALUES($1,$2,$3)
     ON CONFLICT(chat_key) DO UPDATE SET principal_id=$2,last_run_id=$3,updated_at=now()`,
    [key, principalId, runId],
  );
  await db.query("INSERT INTO feishu_replies(message_id,principal_id,run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [msg.messageId, principalId, runId]);
  return "run " + runId;
}

/** Deliver results for pending replies (polled; durable across restarts). */
export async function pumpReplies(deps: FeishuDeps) {
  const open = await db.query(
    `SELECT f.message_id,f.principal_id,f.run_id,f.approval_notified,f.created_at<now()-make_interval(mins=>$1) AS expired,
            r.state,r.error,r.conversation_id,
            EXISTS(SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.state='pending') AS needs_approval
     FROM feishu_replies f LEFT JOIN runs r ON r.id=f.run_id WHERE f.done_at IS NULL ORDER BY f.created_at LIMIT 50`,
    [REPLY_TIMEOUT_MINUTES],
  );
  for (const row of open.rows) {
    const done = (text: string) =>
      deps.transport.reply(row.message_id, text).then(() => db.query("UPDATE feishu_replies SET done_at=now() WHERE message_id=$1", [row.message_id]));
    try {
      if (!row.state) await done("任务不存在。");
      else if (["succeeded", "failed", "cancelled"].includes(row.state)) {
        let text: string | undefined;
        if (row.state === "succeeded") {
          const log = await deps.api(row.principal_id, "GET", `/v1/runs/${row.run_id}/eventlog`);
          const events = (log.json?.events ?? []) as Array<{ event: { type?: string; message?: { role?: string; content?: string } } }>;
          text = events.filter((e) => e.event.type === "message" && e.event.message?.role === "assistant").at(-1)?.event.message?.content;
        }
        await done(finalReply(row.state, text, row.error, link(deps, row.conversation_id)));
      } else if (row.needs_approval && !row.approval_notified) {
        await deps.transport.reply(row.message_id, `任务需要你确认一个操作，请到工作台处理：${link(deps, row.conversation_id) ?? "工作台"}`);
        await db.query("UPDATE feishu_replies SET approval_notified=true WHERE message_id=$1", [row.message_id]);
      } else if (row.expired) await done(`任务仍在运行，请到工作台查看：${link(deps, row.conversation_id) ?? ""}`);
    } catch (e) {
      console.error("feishu reply failed", row.run_id, e instanceof Error ? e.name : "error");
    }
  }
  await db.query("DELETE FROM feishu_messages WHERE received_at<now()-interval '7 days'");
}

/** In-process API call as a principal, with a 5-minute session row that is removed right after. */
export function inProcessApi(request: (path: string, init: RequestInit) => Response | Promise<Response>): Api {
  return async (principalId, method, path, body) => {
    const token = randomBytes(32).toString("base64url");
    const id = "fs_" + randomUUID();
    await db.query("INSERT INTO auth_sessions(id,owner_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [id, principalId, hash(token)]);
    try {
      const res = await request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    } finally {
      await db.query("DELETE FROM auth_sessions WHERE id=$1", [id]);
    }
  };
}
