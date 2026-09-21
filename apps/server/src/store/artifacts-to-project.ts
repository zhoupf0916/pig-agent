import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolveInWorkspace } from "../agent/sandbox.ts";
import type { Artifact, ProjectAsset, Session } from "../types.ts";
import { getProject, upsertAsset } from "./projects.ts";
import { loadSettings } from "./settings.ts";

export const MAX_ARTIFACT_ASSET_BYTES = 1_500_000;

export class ArtifactSaveError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ArtifactSaveError";
    this.status = status;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function decodeArtifactName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** Exact path, then unique basename. Ambiguous basenames throw 409. */
export function findSessionArtifact(session: Session, name: string): Artifact {
  const decoded = decodeArtifactName(name);
  const exact = session.artifacts.find((a) => a.path === decoded || a.path === name);
  if (exact) return exact;
  const base = basename(decoded);
  const matches = session.artifacts.filter((a) => basename(a.path) === base);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new ArtifactSaveError(
      `Ambiguous artifact name "${base}"; pass the full path`,
      409,
    );
  }
  throw new ArtifactSaveError(`Artifact not found: ${decoded}`, 404);
}

export function isSavableArtifact(artifact: Artifact): boolean {
  return artifact.action !== "deleted";
}

/** Newest created/modified/moved artifacts, for handoff "attach recent". */
export function recentSavableArtifactPaths(session: Session, limit = 8): string[] {
  return session.artifacts
    .filter(isSavableArtifact)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((a) => a.path);
}

export async function readArtifactBytes(
  workspaceRoot: string,
  artifact: Artifact,
): Promise<Buffer> {
  if (!isSavableArtifact(artifact)) {
    throw new ArtifactSaveError(`Cannot save deleted artifact: ${artifact.path}`, 400);
  }
  const abs = resolveInWorkspace(workspaceRoot, artifact.path, { mustExist: true });
  const st = await stat(abs);
  if (st.isDirectory()) {
    throw new ArtifactSaveError(`Artifact is a directory: ${artifact.path}`, 400);
  }
  if (st.size > MAX_ARTIFACT_ASSET_BYTES) {
    throw new ArtifactSaveError("artifact too large (1.5MB max)", 400);
  }
  return readFile(abs);
}

export type SavedArtifact = {
  artifactPath: string;
  asset: ProjectAsset;
  overwritten: boolean;
};

export type SkippedArtifact = {
  artifactPath: string;
  reason: string;
};

export type SaveArtifactsResult = {
  projectId: string;
  saved: SavedArtifact[];
  skipped: SkippedArtifact[];
};

function requireBoundProject(session: Session): string {
  const projectId = session.projectId?.trim();
  if (!projectId) {
    throw new ArtifactSaveError("Session is not bound to a project", 400);
  }
  return projectId;
}

async function copyOne(
  session: Session,
  artifact: Artifact,
  workspaceRoot: string,
): Promise<SavedArtifact> {
  const projectId = requireBoundProject(session);
  const project = await getProject(projectId);
  if (!project) throw new ArtifactSaveError("Project not found", 404);
  const content = await readArtifactBytes(workspaceRoot, artifact);
  const result = await upsertAsset(projectId, {
    filename: basename(artifact.path),
    content,
    mimeType: guessMimeType(artifact.path),
    sourceSessionId: session.id,
    sourceArtifactPath: artifact.path,
  });
  if (!result) throw new ArtifactSaveError("Project not found", 404);
  return {
    artifactPath: artifact.path,
    asset: result.asset,
    overwritten: result.overwritten,
  };
}

export async function saveSessionArtifactToProject(
  session: Session,
  name: string,
  workspaceRoot?: string,
): Promise<SavedArtifact & { projectId: string }> {
  const projectId = requireBoundProject(session);
  const artifact = findSessionArtifact(session, name);
  const settings = workspaceRoot ? { workspaceRoot } : await loadSettings();
  const saved = await copyOne(session, artifact, settings.workspaceRoot);
  return { ...saved, projectId };
}

export async function saveAllSessionArtifactsToProject(
  session: Session,
  options: { paths?: string[]; workspaceRoot?: string } = {},
): Promise<SaveArtifactsResult> {
  const projectId = requireBoundProject(session);
  const project = await getProject(projectId);
  if (!project) throw new ArtifactSaveError("Project not found", 404);

  const wanted = options.paths?.map(decodeArtifactName);
  const artifacts = session.artifacts.filter((a) => !wanted || wanted.includes(a.path));
  const settings = options.workspaceRoot
    ? { workspaceRoot: options.workspaceRoot }
    : await loadSettings();

  const saved: SavedArtifact[] = [];
  const skipped: SkippedArtifact[] = [];

  for (const artifact of artifacts) {
    if (!isSavableArtifact(artifact)) {
      skipped.push({ artifactPath: artifact.path, reason: "deleted" });
      continue;
    }
    try {
      saved.push(await copyOne(session, artifact, settings.workspaceRoot));
    } catch (err) {
      skipped.push({
        artifactPath: artifact.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { projectId, saved, skipped };
}
