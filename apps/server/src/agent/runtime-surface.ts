import type { AgentRuntime, CloudMode, ExecutionSurface, Settings } from "../types.ts";
import { inspectCloudStatus } from "./cloud/validate.ts";

export type ExecutionSurfaceInput = {
  runtime?: AgentRuntime | string;
  llmModel?: string;
  llmBaseUrl?: string;
  codexModel?: string;
  codexNetworkAccess?: boolean;
  cloudMode?: CloudMode | string;
  cloudBaseUrl?: string;
  effectiveBaseUrl?: string;
};

/** User-visible execution-surface chip. Default runtime stays pig. */
export function describeExecutionSurface(input: ExecutionSurfaceInput): ExecutionSurface {
  const runtime = input.runtime === "codex" || input.runtime === "cloud" ? input.runtime : "pig";

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
    const mode: CloudMode = input.cloudMode === "remote" ? "remote" : "local-stub";
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

export function inspectExecutionSurface(settings: Settings): ExecutionSurface {
  const status = inspectCloudStatus(settings);
  return describeExecutionSurface({
    runtime: settings.runtime,
    llmModel: settings.llmModel,
    llmBaseUrl: settings.llmBaseUrl,
    codexModel: settings.codexModel,
    codexNetworkAccess: settings.codexNetworkAccess,
    cloudMode: settings.cloudMode,
    cloudBaseUrl: settings.cloudBaseUrl,
    effectiveBaseUrl: status.effectiveBaseUrl,
  });
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
