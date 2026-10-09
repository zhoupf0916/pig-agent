import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cloudRequest as api } from "./cloud-api";
import "../pwa/pwa.css";

type FeishuState = { enabled: boolean; connected: boolean; botName: string | null; bound: boolean; boundAt: string | null };

/** F3: bind this account to Feishu with a one-time code. Hidden while the bot is not enabled. */
export function FeishuCard() {
  const [state, setState] = useState<FeishuState | null>(null);
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => void api("/v1/feishu").then((s) => setState(s as FeishuState)).catch(() => setState(null)), []);
  useEffect(load, [load]);
  // While a code is shown, poll so the card flips to "bound" as soon as /bind arrives.
  useEffect(() => {
    if (!code || state?.bound) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [code, state?.bound, load]);
  if (!state?.enabled) return null;
  const bot = state.botName || "猪猪 Agent";
  return (
    <section className="pwa-card" aria-labelledby="feishu-card-title">
      <h3 id="feishu-card-title">
        <MessageSquare size={16} aria-hidden /> 飞书
      </h3>
      <div className="pwa-row">
        <div>
          <strong>{state.bound ? "已绑定飞书" : "绑定飞书账号"}</strong>
          <small>
            {state.bound
              ? `私聊「${bot}」或在群里 @它，就会以这个账号执行任务并回复结果。`
              : code && Date.now() < code.expires
                ? `在飞书里私聊「${bot}」，发送：/bind ${code.code}（10 分钟内有效，只能用一次）`
                : `生成一次性绑定码，然后在飞书里私聊「${bot}」发送 /bind 绑定码。`}
          </small>
          {error && <small role="alert">{error}</small>}
        </div>
        {state.bound ? (
          <button type="button" className="secondary" onClick={() => void api("/v1/feishu/binding", "DELETE").then(() => { setCode(null); load(); }).catch((e) => setError(String(e?.message || e)))}>
            解除绑定
          </button>
        ) : (
          <button type="button" className="secondary" onClick={() => void api("/v1/feishu/bind-code", "POST").then((r) => { const v = r as { code: string; expiresInSeconds: number }; setError(""); setCode({ code: v.code, expires: Date.now() + v.expiresInSeconds * 1000 }); }).catch((e) => setError(String(e?.message || e)))}>
            {code ? "重新生成" : "生成绑定码"}
          </button>
        )}
      </div>
      {!state.connected && <small className="pwa-note">机器人连接中断，消息可能暂时收不到。</small>}
    </section>
  );
}
