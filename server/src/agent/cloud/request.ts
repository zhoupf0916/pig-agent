import type { Session, Settings } from "../../types.ts";
import { prependBoundInstructions, type BoundInstructions } from "../bound-instructions.ts";
import { CloudRuntimeError, type CloudCreateRunRequest, type CloudWorkspaceHandoff } from "./contract.ts";
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

export function buildFollowUpRequest(session: Session): { prompt: string } {
  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
  return { prompt: lastUser?.content ?? "" };
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
