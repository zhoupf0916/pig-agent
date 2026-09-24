import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workspaceEditPathError, type SkillSnapshot } from "@pig-agent/contracts";
import { materializeSkillSnapshots } from "../skill-pack.ts";
import { extractWorkspaceSnapshot } from "./snapshot.ts";
import { resolveInWorkspace } from "../sandbox.ts";

type StageInput = {
  skillSnapshots?: SkillSnapshot[];
  files?: Array<{ path: string; content: string }>;
  fileOverrides?: Array<{ path: string; content: string }>;
  projectFiles?: Array<{ path: string; content: string }>;
  workspace?: { snapshot: Parameters<typeof extractWorkspaceSnapshot>[0] };
};

/** Restore the archived workspace first, then place skill files so the archive cannot hide them. */
export async function stageCloudWorkspace(workspaceRoot: string, input: StageInput): Promise<void> {
  if (input.workspace?.snapshot)
    extractWorkspaceSnapshot(input.workspace.snapshot, workspaceRoot, "cloud-result");
  if (!input.workspace?.snapshot) {
    for (const file of input.projectFiles || []) {
      const target = resolveInWorkspace(workspaceRoot, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  }
  for (const file of input.files || [])
    await writeFile(resolveInWorkspace(workspaceRoot, file.path), file.content);
  if (input.skillSnapshots?.length)
    await materializeSkillSnapshots(workspaceRoot, input.skillSnapshots);
  for (const file of input.fileOverrides || []) {
    if (workspaceEditPathError(file.path)) throw new Error("不能把编辑写入该路径");
    const target = resolveInWorkspace(workspaceRoot, file.path);
    let current = workspaceRoot;
    for (const part of file.path.split("/")) {
      current = join(current, part);
      const stat = await lstat(current).catch(() => null);
      if (stat?.isSymbolicLink()) throw new Error("文件编辑不能经过符号链接");
    }
    await mkdir(dirname(target), { recursive: true });
    const parent = await lstat(dirname(target));
    if (parent.isSymbolicLink()) throw new Error("文件编辑不能经过符号链接");
    await writeFile(target, file.content, { flag: "w", mode: 0o600 });
  }
}
