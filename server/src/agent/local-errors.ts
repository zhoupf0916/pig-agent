import { LlmError } from "./openai.ts";
import type { ChatMessage, LocalRetryKind, Session } from "../types.ts";

export type LocalErrorCode =
  | "bad_key"
  | "rate_limited"
  | "gateway_unreachable"
  | "gateway_timeout"
  | "gateway_http"
  | "tool_failed"
  | "generic";

export const LOCAL_TURN_MESSAGES = {
  bad_key: "LLM 密钥无效或未授权。请在设置中检查 API Key 后重试本轮。",
  rate_limited: "LLM 网关请求过于频繁。请稍后再重试本轮。",
  gateway_unreachable: "无法连接 LLM 网关。请检查设置中的 Base URL，或确认网关已启动。",
  gateway_timeout: "LLM 网关请求超时。请稍后重试本轮。",
  gateway_http: "LLM 网关返回错误。",
  tool_failed: "工具调用失败，本轮已停止。可重试本轮，或换一种做法。",
  generic: "本轮执行失败。可重试本轮。",
} as const satisfies Record<LocalErrorCode, string>;

const SECRET_DETAIL_RE =
  /(sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY\s*[:=]\s*\S+|CODEX_API_KEY\s*[:=]\s*\S+|OPENAI_API_KEY\s*[:=]\s*\S+|LLM_API_KEY\s*[:=]\s*\S+|PIG_CLOUD_TOKEN\s*[:=]\s*\S+|CLOUD_TOKEN\s*[:=]\s*\S+)/gi;

/** Strip provider keys / tokens so lastError never shows secrets in the UI. */
export function redactLocalErrorDetail(text: string): string {
  return text.replace(SECRET_DETAIL_RE, "…");
}

export function isRetryableUserMessage(message: ChatMessage): boolean {
  return message.role === "user" && !message.content.startsWith("[harness]");
}

export function hasRetryableUserGoal(session: Pick<Session, "messages">): boolean {
  return session.messages.some(isRetryableUserMessage);
}

/** Drop assistant / tool / harness rows after the last real user goal. */
export function rewindToLastUserGoal(session: Session): void {
  let last = -1;
  for (let i = 0; i < session.messages.length; i += 1) {
    const row = session.messages[i];
    if (row && isRetryableUserMessage(row)) last = i;
  }
  if (last >= 0) {
    session.messages = session.messages.slice(0, last + 1);
  }
  session.steps = [];
}

export function decideLocalRetry(session: Pick<Session, "messages">): LocalRetryKind {
  return hasRetryableUserGoal(session) ? "turn" : "unavailable";
}

export function inferLocalErrorCode(err: unknown): LocalErrorCode {
  if (err instanceof LlmError && typeof err.status === "number") {
    if (err.status === 401 || err.status === 403) return "bad_key";
    if (err.status === 429) return "rate_limited";
    if (err.status === 408 || err.status === 504) return "gateway_timeout";
    if (err.status >= 400) return "gateway_http";
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (/401|403|invalid api key|incorrect api key|authentication|unauthorized|密钥无效|未授权/i.test(raw)) {
    return "bad_key";
  }
  if (/429|rate limit|too many requests|过于频繁/i.test(raw)) return "rate_limited";
  if (
    /timeout|TimeoutError|aborted due to timeout|网关请求超时/i.test(raw) ||
    (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "TimeoutError")
  ) {
    return "gateway_timeout";
  }
  if (
    /Cannot reach LLM|ECONNREFUSED|ENOTFOUND|fetch failed|network|socket hang up|无法连接 LLM/i.test(
      raw,
    )
  ) {
    return "gateway_unreachable";
  }
  if (/LLM HTTP\s*[45]\d\d/i.test(raw)) return "gateway_http";
  if (/Sandbox|tool failed|工具调用失败|executeTool|Unknown tool/i.test(raw)) {
    return "tool_failed";
  }
  return "generic";
}

export function formatLocalTurnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactLocalErrorDetail(raw.trim());
  if (!redacted) return LOCAL_TURN_MESSAGES.generic;
  const code = inferLocalErrorCode(err);
  const base = LOCAL_TURN_MESSAGES[code];
  if (code === "generic" && /[\u4e00-\u9fff]/.test(redacted)) {
    return redacted;
  }
  if (code === "gateway_http") {
    const extra = compactGatewayDetail(redacted);
    return extra ? `${base}（${extra}）` : base;
  }
  return base;
}

function compactGatewayDetail(raw: string): string {
  const http = raw.match(/LLM HTTP\s+(\d{3})\s*:?\s*(.*)$/i);
  if (http) {
    const status = http[1];
    const body = redactLocalErrorDetail((http[2] ?? "").replace(/\s+/g, " ").trim()).slice(0, 120);
    return body ? `HTTP ${status} ${body}` : `HTTP ${status}`;
  }
  return redactLocalErrorDetail(raw.replace(/\s+/g, " ")).slice(0, 120);
}
