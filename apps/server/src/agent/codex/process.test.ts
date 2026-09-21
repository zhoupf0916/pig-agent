import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexExecArgs, killProcessGroup, runCodexExec, SIGKILL_GRACE_MS } from "./process.ts";

describe("buildCodexExecArgs", () => {
  it("passes -C as the trusted workspace and keeps network off by default", () => {
    const workspace = "/tmp/trusted-ws";
    const args = buildCodexExecArgs({
      workspaceReal: workspace,
      prompt: "write hello.md",
      model: "deepseek-flash",
    });
    expect(args[args.indexOf("-C") + 1]).toBe(workspace);
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("--color") + 1]).toBe("never");
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args.at(-1)).toBe("write hello.md");
  });
});

describe("killProcessGroup", () => {
  it("sends SIGTERM to the process group then SIGKILL after the grace period", async () => {
    const signals: Array<{ pid: number; signal: string }> = [];
    let releaseSleep: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let sleptMs = 0;

    const pending = killProcessGroup(
      { pid: 4242, killed: true, exitCode: null, kill: () => true },
      {
        graceMs: SIGKILL_GRACE_MS,
        kill: (pid, signal) => {
          signals.push({ pid, signal: String(signal) });
        },
        sleep: async (ms) => {
          sleptMs = ms;
          await gate;
        },
      },
    );

    await Promise.resolve();
    expect(signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(sleptMs).toBe(1500);

    releaseSleep();
    await pending;
    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  it("aborts a live detached child via process-group kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pig-codex-kill-"));
    const script = join(dir, "hang.sh");
    writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(script, 0o755);
    const workspace = mkdtempSync(join(tmpdir(), "pig-codex-ws-"));
    const controller = new AbortController();
    const pending = runCodexExec({
      binary: script,
      prompt: "hang",
      workspaceReal: workspace,
      home: dir,
      model: "deepseek-flash",
      networkAccess: false,
      signal: controller.signal,
      onLine: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
  });
});

 it("never spawns a process for an already cancelled turn", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runCodexExec({ binary: "/must-not-start", prompt: "test", workspaceReal: "/tmp", home: "/tmp", model: "test", networkAccess: false, signal: controller.signal, onLine: () => {} });
  expect(result.aborted).toBe(true);
});
