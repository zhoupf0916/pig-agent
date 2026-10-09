// Feishu (open.feishu.cn) long-connection transport via the official SDK. Only loaded when enabled.
import * as lark from "@larksuiteoapi/node-sdk";
import { handleEvent, pumpReplies, type Api, type FeishuDeps } from "./service.ts";
import type { FeishuMessageEvent } from "./text.ts";

import { feishuStatus } from "./client-status.ts";

export async function startFeishu(api: Api) {
  const appId = process.env.FEISHU_APP_ID!, appSecret = process.env.FEISHU_APP_SECRET!;
  const base = { appId, appSecret, domain: lark.Domain.Feishu };
  const client = new lark.Client({ ...base, loggerLevel: lark.LoggerLevel.warn });
  feishuStatus.enabled = true;
  let botOpenId: string | undefined;
  const loadBot = async () => {
    try {
      const info = (await client.request({ method: "GET", url: "/open-apis/bot/v3/info" })) as { bot?: { open_id?: string; app_name?: string } };
      botOpenId = info.bot?.open_id;
      feishuStatus.botName = info.bot?.app_name;
      feishuStatus.lastError = undefined;
    } catch (e) {
      // Never log SDK error objects: they can carry request headers.
      feishuStatus.lastError = "bot info unavailable: " + (e instanceof Error ? e.message.slice(0, 120) : "error");
    }
  };
  await loadBot();
  const deps: FeishuDeps = {
    api,
    botOpenId: () => botOpenId,
    origin: () => process.env.WEB_PUBLIC_ORIGIN?.replace(/\/$/, ""),
    transport: {
      async reply(messageId, text) {
        await client.im.message.reply({ path: { message_id: messageId }, data: { msg_type: "text", content: JSON.stringify({ text }) } });
      },
    },
  };
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      feishuStatus.lastEventAt = new Date().toISOString();
      if (!botOpenId) await loadBot();
      // Ack fast; the run itself is tracked by the reply pump.
      void handleEvent(data as FeishuMessageEvent, deps).catch((e) => console.error("feishu event failed", e instanceof Error ? e.name : "error"));
    },
  });
  const ws = new lark.WSClient({ ...base, loggerLevel: lark.LoggerLevel.warn });
  await ws.start({ eventDispatcher: dispatcher });
  feishuStatus.connected = true;
  setInterval(() => void pumpReplies(deps).catch(() => {}), 3000).unref();
  console.log("feishu: long connection started");
}
