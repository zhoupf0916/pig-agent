import type { WorkspaceNode } from "../types";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only workspace tree refresh interval. Same-host tabs pick up sandbox files from GET /api/workspace/tree. */
export const WORKSPACE_TREE_POLL_MS = 2_000;

/** Fields the workstation file tree actually paints. Never file contents / secrets. */
export function sanitizeWorkspaceTree(node: WorkspaceNode): WorkspaceNode {
  const clean: WorkspaceNode = {
    name: node.name,
    path: node.path,
    type: node.type,
  };
  if (node.type === "file" && typeof node.size === "number") {
    clean.size = node.size;
  }
  if (node.type === "dir") {
    clean.children = (node.children ?? []).map(sanitizeWorkspaceTree);
  }
  return clean;
}

export function workspaceTreeSyncKey(node: WorkspaceNode | null): string {
  if (!node) return "";
  const kids = (node.children ?? []).map(workspaceTreeSyncKey).join("\u0002");
  return [node.path, node.type, node.name, node.size ?? "", kids].join("\u0001");
}

/** Paths the workspace browser lists (files only). Used by tests / change detection. */
export function workspaceTreeFilePaths(node: WorkspaceNode | null): string[] {
  if (!node) return [];
  if (node.type === "file") return [node.path];
  return (node.children ?? []).flatMap(workspaceTreeFilePaths);
}

/**
 * Replace the workspace browser tree with a GET /api/workspace/tree snapshot.
 * Same reference when nothing visible changed (avoids extra FileTree remounts).
 * Read-only: never writes workspace files, session JSON, or events.jsonl.
 */
export function applyWorkspaceTreeSnapshot(
  prev: WorkspaceNode | null,
  next: WorkspaceNode,
): WorkspaceNode {
  const clean = sanitizeWorkspaceTree(next);
  if (prev && workspaceTreeSyncKey(prev) === workspaceTreeSyncKey(clean)) {
    return prev;
  }
  return clean;
}

/**
 * Periodically GET the existing workspace tree (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startWorkspaceTreeSync(opts: {
  fetchTree: () => Promise<WorkspaceNode>;
  onTree: (next: WorkspaceNode) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? WORKSPACE_TREE_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await opts.fetchTree();
      if (!stopped) opts.onTree(next);
    } catch {
      // keep the last good tree
    } finally {
      inFlight = false;
    }
  };

  const tick = () => {
    if (clock.isVisible()) void refresh();
  };

  void refresh();
  const timer = clock.setInterval(tick, intervalMs);
  clock.addListener("visibilitychange", tick);
  clock.addListener("focus", tick);

  return () => {
    stopped = true;
    clock.clearInterval(timer);
    clock.removeListener("visibilitychange", tick);
    clock.removeListener("focus", tick);
  };
}
