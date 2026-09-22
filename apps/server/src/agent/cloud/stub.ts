import { resolveCloudRunsDir } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { newId } from "../../util.ts";
import { runAgent } from "../runtime.ts";
import {
  CreateRunProgress,
  isLocalStubProgressStep,
} from "./create-run-progress.ts";
import { syncArtifactToHost, materializeCloudWorkspace } from "./workspace.ts";

function isPigLiveEvent(event: AgentEvent): boolean {
  return event.type === "token" || event.type === "tool_start";
}

export async function runStubCloudAgent(options: {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  runsRoot?: string;
  projectInstruction?: string;
  expertInstruction?: string;
  preferredSkillIds?: string[];
}): Promise<Session> {
  const { settings, signal, emit } = options;
  const session = options.session;
  const progress = new CreateRunProgress(session, emit);
  const runId = newId("run");

  let isolated: { runDir: string; workspaceRoot: string };
  try {
    progress.begin("materialize");
    isolated = materializeCloudWorkspace({
      sourceRoot: settings.workspaceRoot,
      runId,
      runsRoot: options.runsRoot ?? resolveCloudRunsDir(),
      sessionId: session.id,
    });
    progress.begin("start");
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.message === "Aborted")) {
      progress.abort();
    } else {
      progress.fail();
    }
    throw err;
  }

  const stubSettings: Settings = {
    ...settings,
    runtime: "pig",
    workspaceRoot: isolated.workspaceRoot,
  };

  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let handedOff = false;
  const releaseBootstrap = () => {
    if (handedOff) return;
    handedOff = true;
    if (signal.aborted) progress.abort();
    else progress.handoffToStream();
  };

  try {
    const result = await runAgent({
      allowComputer: false,
      session: {
        ...session,
        // Local-cloud has its own workspace lifecycle; host review is Pig-only.
        deliveryMode: false,
        steps: session.steps.filter((step) => !isLocalStubProgressStep(step)),
      },
      settings: stubSettings,
      signal: inner.signal,
      projectInstruction: options.projectInstruction,
      expertInstruction: options.expertInstruction,
      preferredSkillIds: options.preferredSkillIds,
      emit: (event) => {
        if (isPigLiveEvent(event)) {
          releaseBootstrap();
        } else if (
          event.type === "error" ||
          event.type === "done" ||
          (event.type === "status" && event.status !== "running")
        ) {
          releaseBootstrap();
        }
        if (event.type === "done") {
          event.session.steps = event.session.steps.filter((step) => !isLocalStubProgressStep(step));
        }
        if (event.type === "artifact") {
          syncArtifactToHost(isolated.workspaceRoot, settings.workspaceRoot, event.artifact);
        }
        emit(event);
      },
    });
    releaseBootstrap();
    result.steps = result.steps.filter((step) => !isLocalStubProgressStep(step));
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
