import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { paintedOpenAssetPreviewSourceSession } from "../lib/projects-sync";
import type { AssetPreview, ProjectAsset } from "../types";
import { MarkdownView } from "./MarkdownView";

export function AssetPreviewModal({
  projectId,
  asset,
  onClose,
  onOpenSession,
}: {
  projectId: string;
  asset: ProjectAsset;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [preview, setPreview] = useState<AssetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void api
      .assetPreview(projectId, asset.id)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, asset.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const downloadHref = api.assetDownloadUrl(projectId, asset.id);
  // AA snapshot is source of truth — do not keep a stale preview GET session id.
  const sourceSession = paintedOpenAssetPreviewSourceSession(asset);
  const sourcePath = preview?.asset.sourceArtifactPath ?? asset.sourceArtifactPath;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-ink-300 bg-panel shadow-lift">
        <div className="flex items-start justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm text-ink-800">{asset.filename}</h2>
            <p className="mt-1 text-xs text-ink-500">
              {formatBytes(preview?.size ?? asset.size)}
              {preview?.kind ? ` · ${kindLabel(preview.kind)}` : ""}
              {asset.mimeType ? ` · ${asset.mimeType}` : ""}
            </p>
            {(sourcePath || sourceSession) && (
              <p className="mt-1 text-xs text-ink-500">
                {sourcePath && <span>来自产物 {sourcePath}</span>}
                {sourceSession && onOpenSession && (
                  <button
                    type="button"
                    className="ml-2 text-accent hover:underline"
                    onClick={() => onOpenSession(sourceSession.sessionId)}
                  >
                    {sourceSession.label}
                  </button>
                )}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={downloadHref} className="btn-ghost" download={asset.filename}>
              <Download size={13} />
              下载
            </a>
            <button type="button" className="btn-ghost" onClick={onClose} aria-label="关闭预览">
              <X size={13} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          {!error && !preview && <p className="text-xs text-ink-500">正在读取预览…</p>}
          {preview?.kind === "markdown" && <MarkdownView text={preview.content} />}
          {preview?.kind === "json" && (
            <pre className="whitespace-pre-wrap font-mono text-[13px] leading-5 text-ink-700">
              {preview.content}
            </pre>
          )}
          {preview?.kind === "text" && (
            <pre className="whitespace-pre-wrap font-mono text-[13px] leading-5 text-ink-700">
              {preview.content}
            </pre>
          )}
          {preview?.kind === "image" && preview.contentBase64 && (
            <img
              src={`data:${preview.asset.mimeType || "image/png"};base64,${preview.contentBase64}`}
              alt={asset.filename}
              className="mx-auto max-h-[60vh] max-w-full rounded-btn border border-ink-200"
            />
          )}
          {preview?.kind === "binary" && (
            <p className="text-xs text-ink-500">二进制文件，无法预览。请下载后用本机应用打开。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function kindLabel(kind: AssetPreview["kind"]): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "json") return "JSON";
  if (kind === "image") return "图片";
  if (kind === "text") return "文本";
  return "二进制";
}
