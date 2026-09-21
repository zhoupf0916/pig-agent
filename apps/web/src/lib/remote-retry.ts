import type { LocalRetryKind, RemoteRetryKind } from "../types";

/** Banner button after a failed turn. Remote L labels stay; pig/codex use 重试本轮. */
export function retryActionLabel(kind?: RemoteRetryKind, local?: LocalRetryKind): string {
  if (kind === "follow-up") return "重试 · 继续跟进";
  if (kind === "create-run") return "重试 · 重新创建运行";
  if (kind === "unavailable") return "重试";
  if (local === "unavailable") return "无法重试";
  return "重试本轮";
}

const SECRET_RE =
  /(sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY\s*[:=]\s*\S+|CODEX_API_KEY\s*[:=]\s*\S+|PIG_CLOUD_TOKEN\s*[:=]\s*\S+)/gi;

/** Never render provider keys / tokens in the workstation banner. */
export function redactSecretsForDisplay(text: string): string {
  return text.replace(SECRET_RE, "…");
}
