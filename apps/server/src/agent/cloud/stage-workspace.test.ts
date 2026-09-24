import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillMaterialPrefix, type SkillSnapshot } from "@pig-agent/contracts";
import { packWorkspaceSnapshot } from "./snapshot.ts";
import { stageCloudWorkspace } from "./stage-workspace.ts";

const snapshot: SkillSnapshot = {
  id: "audit-pack",
  name: "audit-pack",
  description: "验证",
  body: "技能正文",
  files: [],
};

describe("cloud workspace staging", () => {
  it("restores shared files and still materializes skills that were not exported", async () => {
    const archived = await mkdtemp(join(tmpdir(), "pig-archive-"));
    const prefix = skillMaterialPrefix(snapshot);
    await mkdir(join(archived, prefix), { recursive: true });
    await writeFile(join(archived, prefix, "SKILL.md"), "archive-copy");
    await writeFile(join(archived, "notes.txt"), "keep");
    const packed = packWorkspaceSnapshot(archived, [], "cloud-result");
    expect(packed.files).not.toEqual(expect.arrayContaining([expect.stringContaining(".pig")]));
    const dest = await mkdtemp(join(tmpdir(), "pig-stage-"));
    await stageCloudWorkspace(dest, { workspace: { snapshot: packed }, skillSnapshots: [snapshot] });
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(dest, prefix, "SKILL.md"), "utf8")).toContain("技能正文");
  });

  it("writes skill files after a workspace restore that does not already contain them", async () => {
    const archived = await mkdtemp(join(tmpdir(), "pig-archive-clean-"));
    await writeFile(join(archived, "notes.txt"), "keep");
    const packed = packWorkspaceSnapshot(archived);
    const dest = await mkdtemp(join(tmpdir(), "pig-stage-clean-"));
    await stageCloudWorkspace(dest, { workspace: { snapshot: packed }, skillSnapshots: [snapshot] });
    expect(await readFile(join(dest, "notes.txt"), "utf8")).toBe("keep");
    expect(await readFile(join(dest, skillMaterialPrefix(snapshot), "SKILL.md"), "utf8")).toContain("技能正文");
  });
});
