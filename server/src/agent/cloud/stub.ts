import { resolveCloudRunsDir } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { newId } from "../../util.ts";
import { runAgent } from "../runtime.ts";
import { syncArtifactToHost, materializeCloudWorkspace } from "./workspace.ts";

export async function runStubCloudAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  runsRoot?: string;
  projectInstruction?: string;
}): Promise<Session> {
  const { settings, signal, emit } = options;
  const runId = newId("run");
  const isolated = materializeCloudWorkspace({
    sourceRoot: settings.workspaceRoot,
    runId,
    runsRoot: options.runsRoot ?? resolveCloudRunsDir(),
    sessionId: options.session.id,
  });

  const stubSettings: Settings = {
    ...settings,
    runtime: "pig",
    workspaceRoot: isolated.workspaceRoot,
  };

  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await runAgent({
      session: options.session,
      settings: stubSettings,
      signal: inner.signal,
      projectInstruction: options.projectInstruction,
      emit: (event) => {
        if (event.type === "artifact") {
          syncArtifactToHost(isolated.workspaceRoot, settings.workspaceRoot, event.artifact);
        }
        emit(event);
      },
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
