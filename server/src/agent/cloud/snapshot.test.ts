import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractWorkspaceSnapshot,
  packWorkspaceSnapshot,
  resolveCloudRepoHint,
  shouldSkipCloudHandoffName,
} from "./snapshot.ts";

describe("shouldSkipCloudHandoffName", () => {
  it("skips env files, vcs/deps, and key material", () => {
    expect(shouldSkipCloudHandoffName(".env")).toBe(true);
    expect(shouldSkipCloudHandoffName(".env.local")).toBe(true);
    expect(shouldSkipCloudHandoffName(".env.production")).toBe(true);
    expect(shouldSkipCloudHandoffName("node_modules")).toBe(true);
    expect(shouldSkipCloudHandoffName(".git")).toBe(true);
    expect(shouldSkipCloudHandoffName("id_rsa")).toBe(true);
    expect(shouldSkipCloudHandoffName("secret.pem")).toBe(true);
    expect(shouldSkipCloudHandoffName("ok.md")).toBe(false);
    expect(shouldSkipCloudHandoffName("notes")).toBe(false);
  });
});

describe("workspace snapshot", () => {
  it("packs sandbox-safe files and skips secrets / heavy dirs", () => {
    const source = mkdtempSync(join(tmpdir(), "pig-snap-src-"));
    mkdirSync(join(source, "notes"));
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(source, ".git"), { recursive: true });
    writeFileSync(join(source, "ok.md"), "visible");
    writeFileSync(join(source, "notes", "todo.txt"), "do it");
    writeFileSync(join(source, ".env"), "DEEPSEEK_API_KEY=sk-should-not-pack\n");
    writeFileSync(join(source, ".env.local"), "SECRET=1\n");
    writeFileSync(join(source, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(source, "tls.pem"), "not-a-real-cert");
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "secret-dep");
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main");

    const snapshot = packWorkspaceSnapshot(source);
    expect(snapshot.encoding).toBe("tar.gz");
    expect(snapshot.files).toEqual(expect.arrayContaining(["ok.md", "notes/todo.txt"]));
    expect(snapshot.files.some((f) => f.includes(".env"))).toBe(false);
    expect(snapshot.files).not.toContain("id_rsa");
    expect(snapshot.files).not.toContain("tls.pem");
    expect(snapshot.skipped.some((s) => s === ".env" || s.startsWith(".env"))).toBe(true);
    expect(snapshot.skipped).toEqual(expect.arrayContaining(["node_modules", ".git", "id_rsa"]));
    expect(snapshot.data).not.toContain("sk-should-not-pack");

    const dest = mkdtempSync(join(tmpdir(), "pig-snap-dst-"));
    const extracted = extractWorkspaceSnapshot(snapshot, dest);
    expect(extracted).toEqual(expect.arrayContaining(["ok.md", "notes/todo.txt"]));
    expect(readFileSync(join(dest, "ok.md"), "utf8")).toBe("visible");
    expect(readFileSync(join(dest, "notes", "todo.txt"), "utf8")).toBe("do it");
    expect(existsSync(join(dest, ".env"))).toBe(false);
    expect(existsSync(join(dest, "id_rsa"))).toBe(false);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
  });

  it("reads optional repo hint from env only", () => {
    expect(resolveCloudRepoHint({} as NodeJS.ProcessEnv)).toEqual({});
    expect(
      resolveCloudRepoHint({
        PIG_CLOUD_REPO_URL: "https://github.com/acme/app.git",
        PIG_CLOUD_REPO_REF: "main",
      } as NodeJS.ProcessEnv),
    ).toEqual({ repoUrl: "https://github.com/acme/app.git", ref: "main" });
  });
});
