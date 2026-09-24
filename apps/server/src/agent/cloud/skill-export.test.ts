import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packWorkspaceSnapshot, shouldSkipCloudHandoffName } from "./snapshot.ts";

describe("技能资源不成为共享成果", () => {
  it.each(["local-handoff", "cloud-result"] as const)("%s 不导出任务加载的私人技能文件", mode => {
    const root = mkdtempSync(join(tmpdir(), "pig-skill-export-"));
    mkdirSync(join(root, ".pig/skills/private/references"), { recursive: true });
    writeFileSync(join(root, ".pig/skills/private/references/guide.md"), "PRIVATE_SKILL_BYTES");
    writeFileSync(join(root, "report.md"), "用户成果");
    const snapshot = packWorkspaceSnapshot(root, [], mode);
    expect(snapshot.files).toEqual(["report.md"]);
    expect(shouldSkipCloudHandoffName(".pig")).toBe(true);
  });
});
