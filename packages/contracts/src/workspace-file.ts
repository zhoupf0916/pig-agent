export type WorkspaceFileEdit = {
  path: string;
  content: string;
  baseRevision: string;
  authorId?: string;
};

export type WorkspaceFileVersion = {
  path: string;
  revision: string;
  content: string;
  authorId?: string;
  updatedAt: string;
};

export function workspaceEditPathError(path: string): string | null {
  if (!path || path.length > 200 || path.includes("\0") || path.includes("\\")) return "文件路径无效";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "文件路径无效";
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "文件路径无效";
  if (parts.some((part) => part === ".pig" || part === ".git")) return "不能编辑该路径";
  return null;
}
export function workspaceFileRevision(content: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= BigInt(content.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Shared decision for local and cloud saves. Does not grant write access. */
export function decideFileEdit(input: {
  canWrite: boolean;
  workspaceBusy: boolean;
  baseRevision: string;
  currentRevision: string;
}): "ok" | "readonly" | "busy" | "conflict" {
  if (!input.canWrite) return "readonly";
  if (input.workspaceBusy) return "busy";
  if (input.baseRevision !== input.currentRevision) return "conflict";
  return "ok";
}
