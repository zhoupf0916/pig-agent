import type { Session, Settings } from "../../types.ts";
import type { CloudCreateRunRequest } from "./contract.ts";

/**
 * Body sent to a remote control plane. Intentionally omits API keys, cloud
 * tokens, and absolute local paths so a worker never receives host secrets.
 */
export function buildCreateRunRequest(
  session: Session,
  settings: Settings,
): CloudCreateRunRequest {
  const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
  return {
    prompt: lastUser?.content ?? "",
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
}

export function assertNoSecretsInPayload(payload: unknown, settings: Settings): void {
  const dumped = JSON.stringify(payload);
  const secrets = [settings.llmApiKey, settings.cloudToken].filter((s) => s && s.length >= 4);
  for (const secret of secrets) {
    if (dumped.includes(secret)) {
      throw new Error("Refusing to send provider/control-plane secrets to a cloud worker payload");
    }
  }
}
