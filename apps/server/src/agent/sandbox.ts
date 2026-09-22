import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export function normalizeWorkspaceRoot(root: string): string {
  const resolved = resolve(root);
  if (!existsSync(resolved)) {
    throw new SandboxError(`Workspace root does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

/**
 * Resolve a user-supplied path against the workspace and reject escapes
 * (absolute paths, `..`, and symlink hops that leave the root).
 */
export function resolveInWorkspace(
  workspaceRoot: string,
  userPath: string,
  options: { mustExist?: boolean } = {},
): string {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new SandboxError("Path is required");
  }

  const root = normalizeWorkspaceRoot(workspaceRoot);
  const trimmed = userPath.trim();

  if (trimmed.includes("\0")) {
    throw new SandboxError("Invalid path");
  }

  const candidate = isAbsolute(trimmed)
    ? resolve(normalize(trimmed))
    : resolve(join(root, normalize(trimmed)));

  assertInside(root, candidate);

  if (options.mustExist) {
    if (!existsSync(candidate)) {
      throw new SandboxError(`Path not found: ${toRel(root, candidate)}`);
    }
    return assertRealpathInside(root, candidate);
  }

  if (!existsSync(candidate) && lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new SandboxError("Dangling symbolic link is not a writable workspace file");
  }

  if (existsSync(candidate)) {
    return assertRealpathInside(root, candidate);
  }

  // New file: every existing ancestor must stay inside the workspace
  // (blocks writes through a symlink directory that points outside).
  assertAncestorsInside(root, candidate);
  return candidate;
}

export function toRel(workspaceRoot: string, absolutePath: string): string {
  // resolveInWorkspace returns canonical paths, including for new/deleted files.
  // The configured root may be an alias (e.g. /var -> /private/var on macOS).
  const rel = relative(normalizeWorkspaceRoot(workspaceRoot), absolutePath);
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function isInsideWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  try {
    assertInside(resolve(workspaceRoot), resolve(absolutePath));
    return true;
  } catch {
    return false;
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "") return;
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new SandboxError("Path escapes the workspace root");
  }
}

function assertRealpathInside(root: string, target: string): string {
  const real = realpathSync(target);
  assertInside(root, real);
  return real;
}

function assertAncestorsInside(root: string, target: string): void {
  let current = dirname(target);
  while (true) {
    assertInside(root, current);
    if (current === root) break;
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        assertRealpathInside(root, current);
      } else {
        assertInside(root, current);
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
