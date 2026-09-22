import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkbench, saveWorkbench } from "./workbench.ts";

describe("sandbox policy", () => {
  it("reopens a saved host execution mode as the native sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-policy-"));
    const state = await loadWorkbench("ses_hostmode", root);
    state.policy.shell = "host";
    await saveWorkbench("ses_hostmode", state);
    expect((await loadWorkbench("ses_hostmode", root)).policy.shell).toBe("native");
  });
});
