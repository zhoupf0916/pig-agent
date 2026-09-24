import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillSnapshot } from "@pig-agent/contracts";
import { materializeSkillSnapshots } from "../skill-pack.ts";
import { extractWorkspaceSnapshot } from "./snapshot.ts";
import { resolveInWorkspace } from "../sandbox.ts";

type StageInput = {
  skillSnapshots?: SkillSnapshot[];
  files?: Array<{ path: string; content: string }>;
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
}
