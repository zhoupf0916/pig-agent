import type { CloudStatus, Settings } from "../../types.ts";
import { cloudRemoteError } from "./errors.ts";
import { hasInstallHints, loadInstallHints } from "./environment-json.ts";
import {
  ENV_JSON_FILENAME,
  loadCloudEnvJson,
  resolveCloudRepoHintDetailed,
  resolveEffectiveCloudBaseUrl,
  type CloudHintResolveOptions,
} from "./env-json.ts";

export function inspectCloudStatus(
  settings: Settings,
  options: Omit<CloudHintResolveOptions, "settings"> = {},
): CloudStatus {
  const file = options.envJson
    ? { found: true, path: ENV_JSON_FILENAME, hints: options.envJson }
    : loadCloudEnvJson(options.envJsonPath);
  const effectiveBaseUrl = resolveEffectiveCloudBaseUrl(settings, {
    ...options,
    envJson: file.hints,
  });
  const repoHint = resolveCloudRepoHintDetailed({
    settings,
    envJson: file.hints,
    env: options.env,
  });
  const install = loadInstallHints({ workspaceRoot: settings.workspaceRoot });
  return {
    mode: settings.cloudMode,
    remoteUrlConfigured: Boolean(effectiveBaseUrl),
    tokenPresent: Boolean(settings.cloudToken.trim()),
    envJson: {
      found: file.found,
      file: ENV_JSON_FILENAME,
      ...(file.hints.baseUrl ? { baseUrl: file.hints.baseUrl } : {}),
      ...(file.hints.repoUrl ? { repoUrl: file.hints.repoUrl } : {}),
      ...(file.hints.repoRef ? { repoRef: file.hints.repoRef } : {}),
    },
    ...(repoHint.repoUrl || repoHint.ref ? { repoHint } : {}),
    ...(effectiveBaseUrl ? { effectiveBaseUrl } : {}),
    ...(hasInstallHints(install.hints)
      ? { installHints: install.hints, installHintsFile: install.file }
      : {}),
  };
}

export function resolveEffectiveCloudMode(
  settings: Settings,
  options: Omit<CloudHintResolveOptions, "settings"> = {},
): "local-stub" | "remote" {
  if (settings.cloudMode === "remote") {
    if (!resolveEffectiveCloudBaseUrl(settings, options)) {
      throw cloudRemoteError("missing_url");
    }
    return "remote";
  }
  return "local-stub";
}
