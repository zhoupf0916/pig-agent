import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillMaterialPrefix, type SkillSnapshot } from "@pig-agent/contracts";
import { materializeSkillSnapshots } from "./skill-pack.ts";

const snapshot: SkillSnapshot = { id: "audit-pack", name: "audit-pack", description: "验证", body: "只读资料", files: [] };
const prefix = skillMaterialPrefix(snapshot);
describe("技能包物化边界", () => {
  it("拒绝经 SKILL.md 符号链接覆盖工作区的其他文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-skill-symlink-"));
    await mkdir(join(root, prefix), { recursive: true });
    const original = join(root, "important.txt");
    await writeFile(original, "original");
    await symlink(original, join(root, prefix, "SKILL.md"));
    await expect(materializeSkillSnapshots(root, [snapshot])).rejects.toThrow();
    expect(await readFile(original, "utf8")).toBe("original");
  });
  it("拒绝通过技能目录符号链接隐式写入其他目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-skill-dirlink-"));
    await mkdir(join(root, ".pig/skills"), { recursive: true });
    await mkdir(join(root, "user-files"));
    await symlink(join(root, "user-files"), join(root, ".pig/skills/audit-pack"));
    await expect(materializeSkillSnapshots(root, [snapshot])).rejects.toThrow();
    await expect(readFile(join(root, "user-files/SKILL.md"))).rejects.toThrow();
  });
  it("相同内容可以复用，被改过的摘要路径拒绝覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "pig-skill-version-"));
    await materializeSkillSnapshots(root, [snapshot]);
    await materializeSkillSnapshots(root, [snapshot]);
    const changed = { ...snapshot, body: "另一版" };
    await materializeSkillSnapshots(root, [changed]);
    await writeFile(join(root, skillMaterialPrefix(changed), "SKILL.md"), "tampered");
    await expect(materializeSkillSnapshots(root, [changed])).rejects.toThrow(/拒绝覆盖/);
    expect(await readFile(join(root, prefix, "SKILL.md"), "utf8")).toContain("只读资料");
  });
});
