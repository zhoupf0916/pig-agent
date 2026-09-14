import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../types.ts";
import { executeTool, type ToolContext } from "./tools.ts";

function ctx(root: string): ToolContext {
  const artifacts: Artifact[] = [];
  return {
    workspaceRoot: root,
    artifacts,
    recordArtifact: (path, action) => {
      artifacts.push({ path, action, updatedAt: new Date().toISOString() });
    },
  };
}

describe("workspace tools", () => {
  it("writes, reads, and edits without leaving the sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    const c = ctx(root);

    const written = await executeTool(
      "write_file",
      { path: "notes/hello.md", content: "hello world" },
      c,
    );
    expect(written.output).toContain("Created");
    expect(readFileSync(join(root, "notes/hello.md"), "utf8")).toBe("hello world");

    const listed = await executeTool("list_dir", { path: "notes" }, c);
    expect(listed.output).toContain("hello.md");

    const read = await executeTool("read_file", { path: "notes/hello.md" }, c);
    expect(read.output).toBe("hello world");

    await executeTool(
      "edit_file",
      {
        path: "notes/hello.md",
        old_string: "world",
        new_string: "pig",
      },
      c,
    );
    expect(readFileSync(join(root, "notes/hello.md"), "utf8")).toBe("hello pig");
    expect(c.artifacts.map((a) => a.path)).toContain("notes/hello.md");
  });

  it("rejects write_file that escapes the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("write_file", { path: "../outside.txt", content: "x" }, ctx(root)),
    ).rejects.toThrow(/escape/i);
  });

  it("runs a shell command in the workspace cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    writeFileSync(join(root, "a.txt"), "ok");
    const result = await executeTool("run_shell", { command: "pwd && ls" }, ctx(root));
    const payload = JSON.parse(result.output) as { stdout: string; exit_code: number };
    expect(payload.exit_code).toBe(0);
    expect(payload.stdout).toContain(root);
    expect(payload.stdout).toContain("a.txt");
  });

  it("rejects obvious path-escaping shell commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("run_shell", { command: "cat /etc/passwd" }, ctx(root)),
    ).rejects.toThrow(/rejected/i);
  });
});
