import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxError, resolveInWorkspace } from "./sandbox.ts";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pig-agent-ws-"));
}

describe("resolveInWorkspace", () => {
  it("resolves a relative file inside the root", () => {
    const root = tempWorkspace();
    writeFileSync(join(root, "note.md"), "hi");
    expect(resolveInWorkspace(root, "note.md", { mustExist: true })).toBe(
      join(root, "note.md"),
    );
  });

  it("rejects parent traversal", () => {
    const root = tempWorkspace();
    expect(() => resolveInWorkspace(root, "../secret.txt")).toThrow(SandboxError);
    expect(() => resolveInWorkspace(root, "foo/../../etc/passwd")).toThrow(
      SandboxError,
    );
  });

  it("rejects absolute paths outside the workspace", () => {
    const root = tempWorkspace();
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(SandboxError);
  });

  it("rejects symlink hops that leave the workspace", () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "pig-agent-out-"));
    writeFileSync(join(outside, "leak.txt"), "nope");
    symlinkSync(outside, join(root, "escape"));
    expect(() =>
      resolveInWorkspace(root, "escape/leak.txt", { mustExist: true }),
    ).toThrow(SandboxError);
  });

  it("allows nested new files and creates through existing dirs", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "docs"));
    const next = resolveInWorkspace(root, "docs/new.md");
    expect(next).toBe(join(root, "docs/new.md"));
  });
});
