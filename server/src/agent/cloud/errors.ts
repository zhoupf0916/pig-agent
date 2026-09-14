import { CloudRuntimeError, type CloudRemoteErrorCode } from "./contract.ts";
import type { RemoteRetryKind } from "../../types.ts";

export const DEFAULT_CLOUD_CONTROL_TIMEOUT_MS = 15_000;

export const CLOUD_REMOTE_MESSAGES = {
  missing_url:
    "未配置控制面 URL，无法使用云端 remote 模式。请在设置中填写控制面地址，或通过 env.json / PIG_CLOUD_BASE_URL 提供。",
  invalid_url: "控制面 URL 必须是有效的 http(s) 地址。",
  snapshot_failed: "工作区快照失败。请检查工作区路径是否存在且可读。",
  control_plane_timeout: "控制面请求超时。请确认控制面已启动且网络可达。",
  create_run_failed: "控制面创建运行失败。",
  subscribe_failed: "订阅控制面事件失败。",
  no_run_id: "控制面未返回运行 ID。",
  secrets_refused: "拒绝向控制面发送本机密钥。请检查工作区快照是否误含密钥。",
  run_expired: "远程运行已过期或不存在。可重试以重新创建运行。",
  disconnected: "与控制面的连接已中断。可重试继续跟进，或重新创建运行。",
  generic: "云端远程执行失败。",
} as const satisfies Record<CloudRemoteErrorCode, string>;

const SECRET_DETAIL_RE =
  /(sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY\s*[:=]\s*\S+|OPENAI_API_KEY\s*[:=]\s*\S+|LLM_API_KEY\s*[:=]\s*\S+|PIG_CLOUD_TOKEN\s*[:=]\s*\S+|CLOUD_TOKEN\s*[:=]\s*\S+)/gi;

/** Strip provider keys / tokens so lastError never shows secrets in the UI. */
export function redactCloudErrorDetail(text: string): string {
  return text.replace(SECRET_DETAIL_RE, "…");
}

export function isExpiredHttpStatus(status: number): boolean {
  return status === 404 || status === 410;
}

export function inferCloudRemoteCode(err: unknown): CloudRemoteErrorCode {
  if (err instanceof CloudRuntimeError) return err.code;
  const raw = err instanceof Error ? err.message : String(err);
  if (/Cloud base URL is required|requires a control-plane URL|未配置控制面 URL/i.test(raw)) {
    return "missing_url";
  }
  if (/must be a valid http|must be http|控制面 URL 必须/i.test(raw)) return "invalid_url";
  if (isTimeoutMessage(raw) || (err && typeof err === "object" && "name" in err && err.name === "TimeoutError")) {
    return "control_plane_timeout";
  }
  if (/run expired|run not found|运行已过期/i.test(raw)) return "run_expired";
  if (/ECONNRESET|socket hang up|premature close|UND_ERR_|连接中断|disconnected/i.test(raw)) {
    return "disconnected";
  }
  if (/snapshot|快照/i.test(raw)) return "snapshot_failed";
  if (/Refusing to send provider|secrets/i.test(raw)) return "secrets_refused";
  return "generic";
}

/** Choose follow-up vs new create-run vs unavailable after a remote failure. */
export function decideRemoteRetry(err: unknown, runId?: string): RemoteRetryKind {
  const code = inferCloudRemoteCode(err);
  if (code === "missing_url" || code === "invalid_url") return "unavailable";
  if (
    code === "run_expired" ||
    code === "no_run_id" ||
    code === "create_run_failed" ||
    code === "snapshot_failed" ||
    code === "secrets_refused"
  ) {
    return "create-run";
  }
  if (runId?.trim()) return "follow-up";
  return "create-run";
}

export function cloudRemoteError(
  code: CloudRemoteErrorCode,
  detail?: string,
): CloudRuntimeError {
  return new CloudRuntimeError(cloudRemoteMessage(code, detail), code);
}

export function cloudRemoteMessage(code: CloudRemoteErrorCode, detail?: string): string {
  const base = CLOUD_REMOTE_MESSAGES[code];
  const extra = redactCloudErrorDetail(detail?.trim() ?? "");
  if (!extra) return base;
  if (code === "snapshot_failed") return `工作区快照失败：${extra}`;
  if (code === "create_run_failed" || code === "subscribe_failed") {
    return `${base}${extra.startsWith("（") || extra.startsWith("(") ? extra : ` ${extra}`}`;
  }
  if (code === "generic") return `云端远程执行失败：${extra}`;
  return `${base}（${extra}）`;
}

export function formatCloudRemoteError(err: unknown): string {
  if (err instanceof CloudRuntimeError) return redactCloudErrorDetail(err.message);
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.trim()) return CLOUD_REMOTE_MESSAGES.generic;
  const code = inferCloudRemoteCode(err);
  if (code !== "generic") {
    if (code === "snapshot_failed") {
      return cloudRemoteMessage("snapshot_failed", raw.replace(/^工作区快照失败[：:]?\s*/u, ""));
    }
    return CLOUD_REMOTE_MESSAGES[code];
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(raw)) {
    return "无法连接控制面。请确认地址正确且服务已启动。";
  }
  if (/[\u4e00-\u9fff]/.test(raw)) return redactCloudErrorDetail(raw);
  return cloudRemoteMessage("generic", raw);
}

export function isUserAbort(err: unknown, userSignal?: AbortSignal): boolean {
  if (userSignal?.aborted) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message === "Aborted" || message === "The operation was aborted.";
}

export function isCloudTimeoutError(
  err: unknown,
  userSignal: AbortSignal,
  timeoutSignal?: AbortSignal,
): boolean {
  if (userSignal.aborted) return false;
  if (timeoutSignal?.aborted) return true;
  if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "TimeoutError") {
    return true;
  }
  const raw = err instanceof Error ? err.message : String(err);
  return isTimeoutMessage(raw);
}

function isTimeoutMessage(raw: string): boolean {
  return /timeout|TimeoutError|aborted due to timeout|控制面请求超时/i.test(raw);
}

/** Combine the user abort with a control-plane timeout. */
export function controlPlaneSignals(
  userSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : timeoutSignalFallback(timeoutMs);
  const signal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([userSignal, timeout])
      : anySignalFallback([userSignal, timeout]);
  return { signal, timeout };
}

function timeoutSignalFallback(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function anySignalFallback(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const item of signals) {
    if (item.aborted) {
      ctrl.abort(item.reason);
      return ctrl.signal;
    }
    item.addEventListener("abort", () => ctrl.abort(item.reason), { once: true });
  }
  return ctrl.signal;
}
