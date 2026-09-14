import type { CloudStatus, Settings } from "../../types.ts";

export function inspectCloudStatus(settings: Settings): CloudStatus {
  return {
    mode: settings.cloudMode,
    remoteUrlConfigured: Boolean(settings.cloudBaseUrl.trim()),
    tokenPresent: Boolean(settings.cloudToken.trim()),
  };
}

export function resolveEffectiveCloudMode(settings: Settings): "local-stub" | "remote" {
  if (settings.cloudMode === "remote") {
    if (!settings.cloudBaseUrl.trim()) {
      throw new Error("Cloud remote mode requires a control-plane URL");
    }
    return "remote";
  }
  return "local-stub";
}
