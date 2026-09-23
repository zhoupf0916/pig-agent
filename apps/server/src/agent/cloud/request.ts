import { nativeFileTool } from "../file-helper-client.ts";
import type { Session, Settings } from "../../types.ts";
import { prependBoundInstructions, type BoundInstructions } from "../bound-instructions.ts";
import { CloudRuntimeError, type CloudCreateRunRequest, type CloudFollowUpRequest, type CloudWorkspaceHandoff } from "./contract.ts";
import { loadInstallHints } from "./environment-json.ts";
import { cloudRemoteError } from "./errors.ts";
import { collectWorkspaceHandoff, resolveCloudRepoHint } from "./snapshot.ts";

/**
 * Body sent to a remote control plane. Intentionally omits API keys, cloud
 * tokens, and absolute local paths so a worker never receives host secrets.
 */
export function buildCreateRunRequest(
  session: Session,
  settings: Settings,
  workspace?: CloudWorkspaceHandoff,
  bound?: BoundInstructions,
): CloudCreateRunRequest {
  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
  const body: CloudCreateRunRequest = {
    prompt: prependBoundInstructions(lastUser?.content ?? "", bound ?? {}),
    sessionId: session.id,
    requireApproval: session.remoteRequireApproval !== false,
    ...(session.remoteDebugContent === true ? { debugContent: true } : {}),
    messages: session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    model: settings.llmModel,
  };
  if (
    workspace &&
    (workspace.snapshot || workspace.repoUrl || workspace.ref || workspace.installHints)
  ) {
    body.workspace = workspace;
  }
  return body;
}

export function buildFollowUpRequest(session: Session): CloudFollowUpRequest {
  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
  return {
    prompt: lastUser?.content ?? "",
    ...(session.remoteDebugContent === true ? { debugContent: true } : {}),
  };
}

/** Snapshot of sandbox-safe files plus optional repo / install hints. */
export function buildRemoteWorkspaceHandoff(settings: Settings): CloudWorkspaceHandoff {
  try {
    const install = loadInstallHints({ workspaceRoot: settings.workspaceRoot });
    return collectWorkspaceHandoff({
      workspaceRoot: settings.workspaceRoot,
      ...resolveCloudRepoHint({ settings }),
      installHints: install.hints,
    });
  } catch (err) {
    if (err instanceof CloudRuntimeError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw cloudRemoteError("snapshot_failed", detail);
  }
}

export function assertNoSecretsInPayload(payload: unknown, settings: Settings): void {
  const dumped = JSON.stringify(payload);
  const secrets = [settings.llmApiKey, settings.cloudToken].filter((s) => s && s.length >= 4);
  for (const secret of secrets) {
    if (dumped.includes(secret)) {
      throw cloudRemoteError("secrets_refused");
    }
  }
}

/** Production handoff reads happen inside the native sandbox, including install hint files. */
export async function buildSafeRemoteWorkspaceHandoff(settings: Settings, signal?: AbortSignal): Promise<CloudWorkspaceHandoff> {
  try {
    const safeSettings={cloudRepoUrl:settings.cloudRepoUrl,cloudRepoRef:settings.cloudRepoRef};
    return JSON.parse((await nativeFileTool("__handoff", {settings:safeSettings}, {workspaceRoot:settings.workspaceRoot,shellMode:"native",artifacts:[],recordArtifact:()=>{},signal})).output);
  } catch(error) { throw cloudRemoteError("snapshot_failed",error instanceof Error ? error.message : String(error)); }
}
