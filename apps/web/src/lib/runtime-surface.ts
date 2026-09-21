import type { ExecutionSurface, Session, Settings } from "../types";

export type ExecutionSurfaceInput = {
  runtime?: Settings["runtime"] | string;
  llmModel?: string;
  llmBaseUrl?: string;
  codexModel?: string;
  codexNetworkAccess?: boolean;
  cloudMode?: Settings["cloudMode"] | string;
  cloudBaseUrl?: string;
  effectiveBaseUrl?: string;
};

/** User-visible execution-surface chip. Default runtime stays pig. */
export function describeExecutionSurface(
  input: ExecutionSurfaceInput,
): ExecutionSurface {
  const runtime =
    input.runtime === "codex" || input.runtime === "cloud"
      ? input.runtime
      : "pig";

  if (runtime === "codex") {
    const model = input.codexModel?.trim() || "deepseek-flash";
    const extra = input.codexNetworkAccess ? " · 外网已开" : "";
    const detail = `${model}${extra}`;
    return {
      runtime,
      kind: "codex",
      label: "本机 Codex",
      detail,
      summary: `本机 Codex · ${detail}`,
    };
  }

  if (runtime === "cloud") {
    const mode = input.cloudMode === "remote" ? "remote" : "local-stub";
    if (mode === "remote") {
      const url = (input.effectiveBaseUrl || input.cloudBaseUrl || "").trim();
      const detail = url || "未配置控制面 URL";
      return {
        runtime,
        kind: "cloud-remote",
        mode,
        label: "云端 · remote",
        detail,
        summary: `云端 · remote · ${detail}`,
      };
    }
    return {
      runtime,
      kind: "cloud-stub",
      mode,
      label: "云端 · local-stub",
      detail: "本机隔离桩",
      summary: "云端 · local-stub",
    };
  }

  const model = input.llmModel?.trim() || "deepseek-chat";
  const host = stripProtocol(input.llmBaseUrl ?? "");
  const detail = host ? `${model} · ${host}` : model;
  return {
    runtime: "pig",
    kind: "pig",
    label: "本机 Pig",
    detail,
    summary: `本机 Pig · ${detail}`,
  };
}

export function surfaceFromSettings(settings: Settings): ExecutionSurface {
  if (settings.executionSurface) return settings.executionSurface;
  return describeExecutionSurface({
    runtime: settings.runtime,
    llmModel: settings.llmModel,
    llmBaseUrl: settings.llmBaseUrl,
    codexModel: settings.codexModel,
    codexNetworkAccess: settings.codexNetworkAccess,
    cloudMode: settings.cloudMode,
    cloudBaseUrl: settings.cloudBaseUrl,
    effectiveBaseUrl: settings.cloudStatus?.effectiveBaseUrl,
  });
}

/** A session override outranks the server's cached GLOBAL execution surface. */
export function surfaceForSession(
  settings: Settings,
  session?: Pick<Session, "executionTarget" | "engine"> | null,
): ExecutionSurface {
  if (!session?.executionTarget) return surfaceFromSettings(settings);
  return surfaceFromSettings({
    ...settings,
    executionSurface: undefined,
    runtime:
      session.executionTarget === "remote" ? "cloud" : session.engine || "pig",
    cloudMode:
      session.executionTarget === "remote" ? "remote" : settings.cloudMode,
  });
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
