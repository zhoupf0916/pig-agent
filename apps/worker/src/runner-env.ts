import { join } from "node:path";

/** The runner process home must not be the project workspace, or the sandbox treats that project as the protected home directory. */
export function runnerProcessEnv(
  workspace: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH,
    HOME: join(workspace, "..", ".pig-agent-home"),
    RUN_TOKEN: base.RUN_TOKEN,
    RUN_TIMEOUT_SECONDS: base.RUN_TIMEOUT_SECONDS,
    GATEWAY_URL: base.GATEWAY_URL || "http://gateway:8891",
    PIG_DESKTOP: "1",
    PIG_APP_ROOT: "/app",
    DATA_DIR: join(workspace, "data"),
    WORKSPACE_ROOT: workspace,
    PIG_AGENT_FORCE_NATIVE_SANDBOX: "1",
  };
}
