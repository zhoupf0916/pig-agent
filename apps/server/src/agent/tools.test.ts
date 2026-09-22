import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../types.ts";
import { executeTool, shellRejectedReason, type ToolContext } from "./tools.ts";

function ctx(root: string): ToolContext {
  const artifacts: Artifact[] = [];
  return {
    workspaceRoot: root,
    artifacts,
    recordArtifact: (path, action, extra) => {
      artifacts.push({ path, action, updatedAt: new Date().toISOString(), ...extra });
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
    expect(c.artifacts.at(-1)?.before).toContain("hello world");
    expect(c.artifacts.at(-1)?.after).toContain("hello pig");
  });

  it("rejects write_file that escapes the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("write_file", { path: "../outside.txt", content: "x" }, ctx(root)),
    ).rejects.toThrow(/escape/i);
  });

  it("searches files and rejects escaped search roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes/a.md"), "alpha TODO item");
    writeFileSync(join(root, "notes/b.txt"), "beta");
    const found = await executeTool(
      "search_files",
      { query: "TODO", path: ".", glob: "*.md" },
      ctx(root),
    );
    const payload = JSON.parse(found.output) as { matches: Array<{ path: string; line: number }> };
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]?.path).toBe("notes/a.md");
    expect(payload.matches[0]?.line).toBe(1);

    await expect(
      executeTool("search_files", { query: "x", path: ".." }, ctx(root)),
    ).rejects.toThrow(/escape/i);
  });

  it("moves and deletes inside the sandbox only", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    writeFileSync(join(root, "old.txt"), "keep");
    const c = ctx(root);
    const moved = await executeTool("move_file", { from: "old.txt", to: "archive/old.txt" }, c);
    expect(moved.output).toContain("Moved");
    expect(readFileSync(join(root, "archive/old.txt"), "utf8")).toBe("keep");
    expect(c.artifacts.some((a) => a.action === "moved")).toBe(true);

    await executeTool("delete_file", { path: "archive/old.txt" }, c);
    expect(c.artifacts.some((a) => a.action === "deleted")).toBe(true);

    await expect(
      executeTool("move_file", { from: "missing.txt", to: "../x" }, ctx(root)),
    ).rejects.toThrow();
    await expect(executeTool("delete_file", { path: "../package.json" }, ctx(root))).rejects.toThrow(
      /escape/i,
    );
  });

  it("applies a multi-hunk replacement patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    writeFileSync(join(root, "doc.md"), "title\nbody\nend\n");
    const result = await executeTool(
      "apply_patch",
      {
        path: "doc.md",
        replacements: [
          { old_string: "title", new_string: "Title" },
          { old_string: "end", new_string: "END" },
        ],
      },
      ctx(root),
    );
    expect(result.output).toContain("Patched");
    expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("Title\nbody\nEND\n");
  });

  it("runs a chained shell command inside the workspace sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    writeFileSync(join(root, "a.txt"), "ok");
    const result = await executeTool("run_shell", { command: "pwd && ls" }, ctx(root));
    const payload = JSON.parse(result.output) as {
      stdout: string;
      exit_code: number;
      preferred_command: boolean;
    };
    expect(payload.exit_code).toBe(0);
    expect(payload.preferred_command).toBe(true);
    expect(payload.stdout).toContain(root);
    expect(payload.stdout).toContain("a.txt");
    await expect(executeTool("run_shell", { command: "exit 7" }, ctx(root))).rejects.toThrow('"exit_code": 7');
  });

  it("refuses host execution instead of running on the service process", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("run_shell", { command: "pwd" }, { ...ctx(root), shellMode: "host" }),
    ).rejects.toThrow(/沙箱未启用/);
    await expect(
      executeTool("write_file", { path: "x.txt", content: "no" }, { ...ctx(root), shellMode: "host" }),
    ).rejects.toThrow(/沙箱未启用/);
  });

  it("does not return secret files to the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    writeFileSync(join(root, ".env"), "TOKEN=secret");
    writeFileSync(join(root, "notes.txt"), "visible TOKEN");
    mkdirSync(join(root, "keys"));
    writeFileSync(join(root, "keys", "id_rsa"), "private");
    const listed = JSON.parse((await executeTool("list_dir", { path: "." }, ctx(root))).output) as { entries: Array<{ name: string }> };
    expect(listed.entries.map((entry) => entry.name)).not.toContain(".env");
    expect(listed.entries.map((entry) => entry.name)).toContain("notes.txt");
    await expect(executeTool("read_file", { path: ".env" }, ctx(root))).rejects.toThrow(/secret file/i);
    await expect(executeTool("read_file", { path: "keys/id_rsa" }, ctx(root))).rejects.toThrow(/secret file/i);
    const found = await executeTool("search_files", { query: "TOKEN", path: "." }, ctx(root));
    expect(found.output).not.toContain("secret");
    expect(found.output).toContain("notes.txt");
  });

  it("rejects obvious path-escaping and dangerous shell commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("run_shell", { command: "cat /etc/passwd" }, ctx(root)),
    ).rejects.toThrow(/rejected/i);
    await expect(
      executeTool("run_shell", { command: "sudo rm -rf /" }, ctx(root)),
    ).rejects.toThrow(/rejected/i);
    expect(shellRejectedReason("curl http://169.254.169.254/")).toMatch(/rejected/i);
  });

  it("blocks http_fetch to private or loopback targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-tools-"));
    await expect(
      executeTool("http_fetch", { url: "http://127.0.0.1:1/" }, ctx(root)),
    ).rejects.toThrow(/blocked/i);
    await expect(
      executeTool("http_fetch", { url: "file:///etc/passwd" }, ctx(root)),
    ).rejects.toThrow(/blocked/i);
  });
});
