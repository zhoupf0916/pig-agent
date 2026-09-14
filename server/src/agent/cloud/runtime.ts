import type { AgentEvent, Session, Settings } from "../../types.ts";
import { nowIso } from "../../util.ts";
import { formatCloudRemoteError } from "./errors.ts";
import { runRemoteCloudAgent } from "./remote.ts";
import { runStubCloudAgent } from "./stub.ts";
import { resolveEffectiveCloudMode } from "./validate.ts";

export async function runCloudAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  runsRoot?: string;
  fetchImpl?: typeof fetch;
  projectInstruction?: string;
  expertInstruction?: string;
  preferredSkillIds?: string[];
  /** Control-plane connect timeout (remote only). */
  timeoutMs?: number;
}): Promise<Session> {
  try {
    const mode = resolveEffectiveCloudMode(options.settings);
    if (mode === "remote") {
      return runRemoteCloudAgent(options);
    }
    return runStubCloudAgent(options);
  } catch (err) {
    const message = formatCloudRemoteError(err);
    const session = options.session;
    session.status = "error";
    session.lastError = message;
    session.updatedAt = nowIso();
    options.emit({ type: "error", message });
    options.emit({ type: "status", status: "error" });
    options.emit({ type: "done", session });
    return session;
  }
}
