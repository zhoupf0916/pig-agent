import { nativeFileTool } from "./agent/file-helper-client.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveInWorkspace, toRel } from "./agent/sandbox.ts";
import type { WorkspaceNode } from "./types.ts";

const IGNORE = new Set([".git", "node_modules", ".DS_Store", "dist", "coverage"]);
const MAX_NODES = 1500;

export async function buildTree(
  workspaceRoot: string,
  rel = ".",
  maxDepth = 6,
): Promise<WorkspaceNode> {
  if (process.env.PIG_FILE_HELPER !== "1") return JSON.parse((await nativeFileTool("__tree", {path:rel,maxDepth}, {workspaceRoot,shellMode:"native",artifacts:[],recordArtifact:()=>{}})).output);

  const abs = resolveInWorkspace(workspaceRoot, rel, { mustExist: true });
  let count = 0;

  const walk = async (dir: string, depth: number): Promise<WorkspaceNode[]> => {
    if (depth <= 0 || count >= MAX_NODES) return [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const children: WorkspaceNode[] = [];
    const sorted = entries
      .filter((e) => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of sorted) {
      if (count >= MAX_NODES) break;
      const full = join(dir, entry.name);
      count += 1;
      if (entry.isDirectory()) {
        children.push({
          name: entry.name,
          path: toRel(workspaceRoot, full),
          type: "dir",
          children: await walk(full, depth - 1),
        });
      } else {
        let size: number | undefined;
        try {
          size = (await stat(full)).size;
        } catch {
          size = undefined;
        }
        children.push({
          name: entry.name,
          path: toRel(workspaceRoot, full),
          type: "file",
          size,
        });
      }
    }
    return children;
  };

  const st = await stat(abs);
  if (!st.isDirectory()) {
    return { name: toRel(workspaceRoot, abs), path: toRel(workspaceRoot, abs), type: "file", size: st.size };
  }
  return {
    name: toRel(workspaceRoot, abs),
    path: toRel(workspaceRoot, abs) === "." ? "." : toRel(workspaceRoot, abs),
    type: "dir",
    children: await walk(abs, maxDepth),
  };
}

export async function readWorkspaceText(
  workspaceRoot: string,
  rel: string,
): Promise<{ path: string; content: string; binary: boolean; size: number }> {
  if (process.env.PIG_FILE_HELPER !== "1") return JSON.parse((await nativeFileTool("__preview", {path:rel}, {workspaceRoot,shellMode:"native",artifacts:[],recordArtifact:()=>{}})).output);

  const abs = resolveInWorkspace(workspaceRoot, rel, { mustExist: true });
  const st = await stat(abs);
  if (st.isDirectory()) {
    throw new Error("Path is a directory");
  }
  if (st.size > 1_500_000) {
    throw new Error("File too large to preview");
  }
  const buf = await readFile(abs);
  const binary = buf.includes(0);
  return {
    path: toRel(workspaceRoot, abs),
    content: binary ? "" : buf.toString("utf8"),
    binary,
    size: st.size,
  };
}
