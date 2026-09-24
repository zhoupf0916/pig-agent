import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  skillMaterialPrefix,
  validateSkillName,
  validateSkillPackFiles,
  type SkillSnapshot,
} from "@pig-agent/contracts";
import { normalizeWorkspaceRoot } from "./sandbox.ts";

/** Copy a saved skill snapshot into the task workspace. Does not execute scripts. */
export async function materializeSkillSnapshots(
  workspaceRoot: string,
  snapshots: SkillSnapshot[],
): Promise<void> {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  for (const snapshot of snapshots) {
    if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(snapshot.id))
      throw new Error("技能包路径无效");
    const nameError = validateSkillName(snapshot.name);
    if (nameError) throw new Error(nameError);
    const invalid = validateSkillPackFiles(snapshot.files);
    if (invalid) throw new Error(invalid.message);
    const prefix = skillMaterialPrefix(snapshot);
    const front = [
      "---",
      `name: ${snapshot.name}`,
      `description: ${snapshot.description.replace(/\n/g, " ")}`,
      "---",
      "",
      snapshot.body,
      "",
    ].join("\n");
    await writeSkillFile(root, `${prefix}/SKILL.md`, front);
    for (const file of snapshot.files)
      await writeSkillFile(root, `${prefix}/${file.path}`, file.content);
  }
}

async function writeSkillFile(root: string, relativePath: string, content: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error("技能包路径不能经过符号链接");
  }
  const stat = await lstat(current).catch(() => null);
  if (stat?.isSymbolicLink()) throw new Error("技能包路径不能经过符号链接");
  if (stat?.isFile()) {
    const existing = await readFile(current, "utf8");
    if (existing === content) return;
    throw new Error("技能包内容已被修改，拒绝覆盖");
  }
  await mkdir(dirname(current), { recursive: true });
  const parent = await lstat(dirname(current));
  if (parent.isSymbolicLink()) throw new Error("技能包路径不能经过符号链接");
  await writeFile(current, content, { flag: "wx", mode: 0o600 });
}
