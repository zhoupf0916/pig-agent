import type { LocalRetryKind, Session } from "../../types.ts";
import { decideLocalRetry } from "../local-errors.ts";

export type CodexErrorCode =
  | "binary_missing"
  | "home_unwritable"
  | "api_key_missing"
  | "workspace_invalid"
  | "empty_prompt"
  | "start_failed"
  | "session_failed"
  | "generic";

export const CODEX_TURN_MESSAGES = {
  binary_missing:
    "未找到 Codex 二进制。请安装 Codex CLI，或在设置中填写二进制路径 / CODEX_BIN。",
  home_unwritable: "隔离的 CODEX_HOME 不可写。请检查 PIG_CODEX_HOME 路径权限。",
  api_key_missing:
    "缺少 Codex 专用 API Key。请在设置的 Codex 区域填写；源码模式也可使用 DEEPSEEK_API_KEY 或 CODEX_API_KEY。Pig 密钥不会自动代用。",
  workspace_invalid: "工作区路径无效或与 Codex 信任目录不一致。请在设置中检查工作区后重试本轮。",
  empty_prompt: "没有可发送给 Codex 的用户目标。请先发送一条消息。",
  start_failed: "Codex 进程启动失败。请检查二进制路径与权限后重试本轮。",
  session_failed: "Codex 本轮执行失败。可重试本轮，或检查配置后重试。",
  generic: "Codex 本轮执行失败。可重试本轮。",
} as const satisfies Record<CodexErrorCode, string>;

const SECRET_DETAIL_RE =
  /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY\s*[:=]\s*\S+|CODEX_API_KEY\s*[:=]\s*\S+|OPENAI_API_KEY\s*[:=]\s*\S+|LLM_API_KEY\s*[:=]\s*\S+|PIG_CLOUD_TOKEN\s*[:=]\s*\S+|CLOUD_TOKEN\s*[:=]\s*\S+)/gi;

export class CodexValidationError extends Error {
  readonly code: CodexErrorCode;

  constructor(code: CodexErrorCode, detail?: string) {
    const base = CODEX_TURN_MESSAGES[code];
    const extra = detail?.trim() ? redactCodexErrorDetail(detail.trim()) : "";
    super(extra ? `${base}（${extra}）` : base);
    this.name = "CodexValidationError";
    this.code = code;
  }
}

/** Non-zero exit or mapped JSONL failure after Codex has already started. */
export class CodexSessionError extends Error {
  constructor(detail?: string) {
    const extra = detail?.trim() ? redactCodexErrorDetail(detail.trim()) : "";
    super(extra || CODEX_TURN_MESSAGES.session_failed);
    this.name = "CodexSessionError";
  }
}

/** Strip provider keys / tokens so lastError never shows secrets in the UI. */
export function redactCodexErrorDetail(text: string): string {
  return text.replace(SECRET_DETAIL_RE, "…");
}

export function decideCodexRetry(session: Pick<Session, "messages">): LocalRetryKind {
  return decideLocalRetry(session);
}

export function inferCodexErrorCode(err: unknown): CodexErrorCode {
  if (err instanceof CodexValidationError) return err.code;
  if (err instanceof CodexSessionError || isNamed(err, "CodexSessionError")) {
    return "session_failed";
  }
  if (isNamed(err, "CodexTrustError")) {
    return "workspace_invalid";
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (
    /Codex binary not found|未找到 Codex 二进制|ENOENT.*codex|codex.*ENOENT/i.test(raw)
  ) {
    return "binary_missing";
  }
  if (/CODEX_HOME is not writable|CODEX_HOME 不可写/i.test(raw)) return "home_unwritable";
  if (
    /Missing DEEPSEEK_API_KEY|Missing CODEX_API_KEY|缺少 DEEPSEEK_API_KEY|缺少 CODEX_API_KEY/i.test(
      raw,
    )
  ) {
    return "api_key_missing";
  }
  if (
    /Workspace root|does not match trusted workspace|工作区路径无效/i.test(raw)
  ) {
    return "workspace_invalid";
  }
  if (/No user\/assistant text|没有可发送给 Codex/i.test(raw)) return "empty_prompt";
  if (
    /spawn\s|EACCES|EPERM|EAGAIN|start failed|进程启动失败/i.test(raw) ||
    (err && typeof err === "object" && "code" in err && /ENOENT|EACCES|EPERM/.test(String((err as { code: unknown }).code)))
  ) {
    return "start_failed";
  }
  if (
    /codex exec exited|turn failed|turn\.failed|session exploded|本轮执行失败/i.test(raw)
  ) {
    return "session_failed";
  }
  return "generic";
}

function isNamed(err: unknown, name: string): boolean {
  return Boolean(err && typeof err === "object" && "name" in err && (err as { name: string }).name === name);
}

export function formatCodexTurnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactCodexErrorDetail(raw.trim());
  if (!redacted) return CODEX_TURN_MESSAGES.generic;
  if (err instanceof CodexValidationError) return redactCodexErrorDetail(err.message);
  const code = inferCodexErrorCode(err);
  const base = CODEX_TURN_MESSAGES[code];
  if (code === "generic" && /[\u4e00-\u9fff]/.test(redacted)) {
    return redacted;
  }
  if (code === "session_failed" || code === "start_failed") {
    const extra = compactCodexDetail(redacted, base);
    return extra ? `${base}（${extra}）` : base;
  }
  return base;
}

function compactCodexDetail(raw: string, base: string): string {
  const stripped = raw.replace(base, "").replace(/^（|）$/g, "").trim();
  const compact = redactCodexErrorDetail(stripped.replace(/\s+/g, " "));
  // Native parser/provider errors often put the actionable cause after a long path.
  return compact.length > 240 ? `…${compact.slice(-240)}` : compact;
}
