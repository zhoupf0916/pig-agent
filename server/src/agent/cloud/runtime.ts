import type { AgentEvent, Session, Settings } from "../../types.ts";
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
}): Promise<Session> {
  const mode = resolveEffectiveCloudMode(options.settings);
  if (mode === "remote") {
    return runRemoteCloudAgent(options);
  }
  return runStubCloudAgent(options);
}
