import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, type ToolContext } from "./tools.ts";
describe("OS-sandboxed file tools", () => {
  it.skipIf(process.platform !== "darwin")(
    "runs real file tools with artifact receipts and refuses outside symlinks",
    async () => {
      const parent = realpathSync(
        await mkdtemp(join(tmpdir(), "pig-file-helper-test-")),
      );
      const root = await mkdtemp(join(parent, "workspace-"));
      const receipts: unknown[] = [];
      const ctx: ToolContext = {
        workspaceRoot: root,
        shellMode: "native",
        artifacts: [],
        recordArtifact: (...v) => receipts.push(v),
      };
      try {
        await writeFile(join(parent, "secret"), "PRIVATE");
        await executeTool(
          "write_file",
          { path: "hello.txt", content: "hello" },
          ctx,
        );
        expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello");
        expect(receipts).toHaveLength(1);
        expect(
          (await executeTool("read_file", { path: "hello.txt" }, ctx)).output,
        ).toBe("hello");
        await symlink(join(parent, "secret"), join(root, "escape"));
        await expect(
          executeTool("read_file", { path: "escape" }, ctx),
        ).rejects.toThrow();
        await expect(
          executeTool("write_file", { path: "escape", content: "oops" }, ctx),
        ).rejects.toThrow();
        expect(await readFile(join(parent, "secret"), "utf8")).toBe("PRIVATE");
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    15000,
  );

  it.skipIf(process.platform !== "darwin")(
    "writes and reads cloud-proof.txt in a project whose home is a different directory",
    async () => {
      const parent = realpathSync(await mkdtemp(join(tmpdir(), "pig-proof-")));
      const workspace = await mkdtemp(join(parent, "project-"));
      const agentHome = await mkdtemp(join(parent, "agent-home-"));
      const previousHome = process.env.HOME;
      const previousForce = process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX;
      process.env.HOME = agentHome;
      process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX = "1";
      const ctx: ToolContext = {
        workspaceRoot: workspace,
        shellMode: "native",
        artifacts: [],
        recordArtifact: () => {},
      };
      try {
        const written = await executeTool("write_file", { path: "cloud-proof.txt", content: "PIG_CLOUD_CONTAINER_OK\n" }, ctx);
        expect(written.sandbox?.effective).toBe("seatbelt");
        expect((await executeTool("read_file", { path: "cloud-proof.txt" }, ctx)).output).toBe("PIG_CLOUD_CONTAINER_OK\n");
        process.env.HOME = workspace;
        await expect(executeTool("write_file", { path: "nope.txt", content: "x" }, { ...ctx, workspaceRoot: workspace })).rejects.toThrow(/主目录/);
      } finally {
        process.env.HOME = previousHome;
        if (previousForce === undefined) delete process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX;
        else process.env.PIG_AGENT_FORCE_NATIVE_SANDBOX = previousForce;
        await rm(parent, { recursive: true, force: true });
      }
    },
    15000,
  );
});
