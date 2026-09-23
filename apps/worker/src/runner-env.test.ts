import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runnerProcessEnv } from "./runner-env.ts";

describe("runner home is not the project workspace", () => {
  it("points HOME at a private directory instead of the project workspace", () => {
    const workspace = join(mkdtempSync(join(tmpdir(), "pig-runner-home-")), "project");
    const env = runnerProcessEnv(workspace, { PATH: "/usr/bin", RUN_TOKEN: "token", RUN_TIMEOUT_SECONDS: "30" });
    expect(env.WORKSPACE_ROOT).toBe(workspace);
    expect(env.HOME).not.toBe(workspace);
    expect(env.PIG_AGENT_FORCE_NATIVE_SANDBOX).toBe("1");
  });
});
