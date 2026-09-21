/** A file path is a display name, never a remote artifact identity. */
export type RemoteArtifactRef = {
  source: "remote";
  runId: string;
  artifactId: string;
  path: string;
  size: number;
};
export type ArtifactPreview = RemoteArtifactRef & { content: string };

export function remoteArtifactUrl(
  ref: Pick<RemoteArtifactRef, "runId" | "artifactId">,
): string {
  return `/api/remote/v1/runs/${encodeURIComponent(ref.runId)}/artifacts/${encodeURIComponent(ref.artifactId)}`;
}

export async function listRemoteArtifacts(
  runId: string,
  signal?: AbortSignal,
): Promise<RemoteArtifactRef[]> {
  const r = await fetch(
    `/api/remote/v1/runs/${encodeURIComponent(runId)}/artifacts`,
    { signal },
  );
  if (!r.ok)
    throw Error(
      r.status === 404
        ? "此运行不存在或当前账号无权访问"
        : "无法读取远端成果，请检查连接后重试",
    );
  const data = (await r.json()) as {
    artifacts: Array<{ id: string; path: string; size: number }>;
  };
  return data.artifacts.map((a) => ({
    source: "remote",
    runId,
    artifactId: a.id,
    path: a.path,
    size: a.size,
  }));
}

export async function readRemoteArtifact(
  ref: RemoteArtifactRef,
  signal?: AbortSignal,
): Promise<ArtifactPreview> {
  const r = await fetch(remoteArtifactUrl(ref), { signal });
  if (!r.ok)
    throw Error(
      r.status === 404
        ? "成果已不可用或当前账号无权访问"
        : "远端成果读取失败，请重试",
    );
  return { ...ref, content: await r.text() };
}
