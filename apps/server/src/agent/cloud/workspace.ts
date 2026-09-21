import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact } from "../../types.ts";
import { nowIso } from "../../util.ts";
import { resolveInWorkspace } from "../sandbox.ts";
import { shouldSkipCloudHandoffName } from "./snapshot.ts";

export function materializeCloudWorkspace(options: {
  sourceRoot: string;
  runId: string;
  runsRoot: string;
  sessionId?: string;
}): { runDir: string; workspaceRoot: string } {
  const runDir = join(options.runsRoot, options.runId);
  const workspaceRoot = join(runDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  if (existsSync(options.sourceRoot)) {
    cpSync(options.sourceRoot, workspaceRoot, {
      recursive: true,
      filter: (src) => {
        const base = src.split(/[\\/]/).pop() ?? src;
        return !shouldSkipCloudHandoffName(base);
      },
    });
  }

  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        id: options.runId,
        sessionId: options.sessionId,
        createdAt: nowIso(),
        mode: "local-stub",
      },
      null,
      2,
    ),
    "utf8",
  );

  return { runDir, workspaceRoot };
}

/** Copy a stub-worker artifact back onto the host workspace so the UI tree stays consistent. */
export function syncArtifactToHost(
  isolatedRoot: string,
  hostRoot: string,
  artifact: Artifact,
): void {
  if (artifact.action === "deleted") {
    try {
      const dest = resolveInWorkspace(hostRoot, artifact.path);
      if (existsSync(dest)) unlinkSync(dest);
    } catch {
      // Host path may already be gone.
    }
    return;
  }

  if (artifact.action === "moved" && artifact.fromPath) {
    try {
      const oldDest = resolveInWorkspace(hostRoot, artifact.fromPath);
      if (existsSync(oldDest)) unlinkSync(oldDest);
    } catch {
      // ignore
    }
  }

  try {
    const src = resolveInWorkspace(isolatedRoot, artifact.path, { mustExist: true });
    const dest = resolveInWorkspace(hostRoot, artifact.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  } catch {
    // Deleted-on-arrival or sandbox miss — leave host as-is.
  }
}
