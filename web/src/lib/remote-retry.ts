import type { RemoteRetryKind } from "../types";

/** Banner button for a failed remote turn. Default runtime stays pig. */
export function retryActionLabel(kind?: RemoteRetryKind): string {
  if (kind === "follow-up") return "重试 · 继续跟进";
  if (kind === "create-run") return "重试 · 重新创建运行";
  return "重试";
}

const SECRET_RE =
  /(sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY\s*[:=]\s*\S+|PIG_CLOUD_TOKEN\s*[:=]\s*\S+)/gi;

/** Never render provider keys / tokens in the workstation banner. */
export function redactSecretsForDisplay(text: string): string {
  return text.replace(SECRET_RE, "…");
}
