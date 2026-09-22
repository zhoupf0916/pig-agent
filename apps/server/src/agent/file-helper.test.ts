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
});
