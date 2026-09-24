import { ChevronRight, FileCode, FileText, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { artifactLabel, formatBytes, isMarkdown } from "../lib/format";
import type { Artifact, ArtifactAction, WorkspaceNode } from "../types";
import { DiffView } from "./DiffView";
import { MarkdownView } from "./MarkdownView";
import { RemoteArtifactPanel } from "./RemoteArtifactPanel";
import { DeveloperPanel } from "./DeveloperPanel";

type Tab = "artifacts" | "workspace" | "debug";
type PreviewMode = "file" | "diff";

const GROUPS: ArtifactAction[] = ["created", "modified", "moved", "deleted"];

export function RightPanel(props: Parameters<typeof LocalRightPanel>[0] & {
  executionTarget?: "local" | "remote";
  remoteRunId?: string;
  remoteState?: string;
  remoteDebugContent?: boolean;
  onRemoteDebugContent?: (enabled: boolean) => void;
  onDeveloperActive?: (active: boolean) => void;
  onOpenSession?: (id: string) => void;
}) {
  return props.executionTarget === "remote" || Boolean(props.remoteRunId)
    ? <RemoteArtifactPanel key={`${props.sessionId}:${props.remoteRunId}`} runId={props.remoteRunId} runState={props.remoteState} sessionId={props.sessionId} onOpenSession={props.onOpenSession} debugContent={props.remoteDebugContent} onDebugContent={props.onRemoteDebugContent} onDeveloperActive={props.onDeveloperActive} />
    : <LocalRightPanel {...props} />;
}

function LocalRightPanel({
  artifacts,
  tree,
  workspaceRoot,
  previewPath,
  preview,
  onOpenFile,
  sessionId,
  projectId,
  projectName,
  onOpenProject,
  onDeveloperActive,
}: {
  artifacts: Artifact[];
  tree: WorkspaceNode | null;
  workspaceRoot: string;
  previewPath: string | null;
  preview: { path: string; content: string; binary: boolean; size: number } | null;
  onOpenFile: (path: string) => void;
  sessionId?: string;
  projectId?: string;
  projectName?: string;
  onOpenProject?: (projectId: string) => void;
  onDeveloperActive?: (active: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("artifacts");
  useEffect(() => {
    onDeveloperActive?.(tab === "debug");
  }, [tab, onDeveloperActive]);
  const [mode, setMode] = useState<PreviewMode>("file");
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; projectId?: string } | null>(null);
  const selected = artifacts.find((a) => a.path === previewPath);
  const bound = Boolean(sessionId && projectId);
  const savable = artifacts.filter((a) => a.action !== "deleted");

  const saveOne = async (path: string) => {
    if (!sessionId || !projectId) return;
    setSaving(path);
    setToast(null);
    try {
      const result = await api.saveArtifactToProject(sessionId, path);
      setToast({
        text: result.overwritten
          ? `已更新项目资产 ${result.asset.filename}`
          : `已保存 ${result.asset.filename} 到项目资产`,
        projectId: result.projectId,
      });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(null);
    }
  };

  const saveAll = async () => {
    if (!sessionId || !projectId) return;
    setSaving("*");
    setToast(null);
    try {
      const result = await api.saveAllArtifactsToProject(sessionId);
      const n = result.saved.length;
      const skip = result.skipped.length;
      setToast({
        text:
          n === 0
            ? skip
              ? `没有可保存的产物（跳过 ${skip}）`
              : "没有可保存的产物"
            : `已保存 ${n} 个产物到项目${skip ? `（跳过 ${skip}）` : ""}`,
        projectId: n > 0 ? result.projectId : undefined,
      });
    } catch (err) {
      setToast({ text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(null);
    }
  };
  const grouped = useMemo(() => {
    return GROUPS.map((action) => ({
      action,
      items: artifacts.filter((a) => a.action === action),
    })).filter((g) => g.items.length > 0);
  }, [artifacts]);

  return (
    <aside className="resource-panel flex h-full min-w-0 flex-col bg-panel" aria-label="本机成果检查器">
      <header className="border-b border-ink-300 px-4 py-3"><p className="text-sm text-ink-600">本机工作区 · 当前文件内容</p></header>
      <div className="flex border-b border-ink-400 bg-panel">
        <TabButton active={tab === "artifacts"} onClick={() => setTab("artifacts")}>
          产物
          {artifacts.length > 0 && (
            <span className="ml-1 rounded-full bg-accent-soft px-1.5 text-meta text-accent">
              {artifacts.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === "workspace"} onClick={() => setTab("workspace")}>
          本机工作区
        </TabButton>
        <TabButton active={tab === "debug"} onClick={() => setTab("debug")}>
          开发者
        </TabButton>
      </div>

      <div className={tab === "debug" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : !previewPath ? "min-h-0 flex-1 overflow-y-auto" : "max-h-[35%] shrink-0 overflow-y-auto"}>
        {tab === "debug" && (
          <DeveloperPanel
            sessionKey={sessionId || "local"}
            url={sessionId ? `/api/sessions/${sessionId}/debug` : ""}
            writable
          />
        )}
        {tab === "artifacts" && (
          <div className="p-3">
            {bound && artifacts.length > 0 && (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-card border border-ink-400 bg-panel px-2 py-1.5">
                <p className="min-w-0 truncate text-meta text-ink-600">
                  项目 {projectName ?? projectId}
                </p>
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  disabled={saving !== null || savable.length === 0}
                  onClick={() => void saveAll()}
                >
                  {saving === "*" ? "保存中…" : "保存到项目"}
                </button>
              </div>
            )}
            {toast && (
              <div className="mb-3 rounded-card border border-ink-300 bg-accent-soft px-2 py-1.5 text-xs text-ink-700">
                <span>{toast.text}</span>
                {toast.projectId && onOpenProject && (
                  <button
                    type="button"
                    className="ml-2 text-accent hover:underline"
                    onClick={() => onOpenProject(toast.projectId!)}
                  >
                    查看资产
                  </button>
                )}
              </div>
            )}
            {artifacts.length === 0 ? (
              <p className="px-1 pt-8 text-center text-xs text-ink-500">
                任务中新建、修改、移动或删除的文件会出现在这里。
              </p>
            ) : (
              <div className="space-y-3">
                {grouped.map((group) => (
                  <div key={group.action}>
                    <div className="mb-1 px-1 text-meta uppercase tracking-[0.14em] text-ink-600">
                      {artifactLabel(group.action)} · {group.items.length}
                    </div>
                    <ul className="space-y-1">
                      {group.items.map((a) => (
                        <li key={a.path} className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setMode(a.before !== undefined && a.after !== undefined ? "diff" : "file");
                              onOpenFile(a.path);
                            }}
                            className={`flex min-w-0 flex-1 items-center gap-2 rounded-btn px-2 py-2 text-left text-xs hover:bg-ink-200 ${
                              previewPath === a.path
                                ? "bg-accent-soft text-ink-800"
                                : "text-ink-800"
                            }`}
                          >
                            <FileCode size={14} className="text-accent-mute" />
                            <span className="min-w-0 flex-1 truncate">
                              {a.action === "moved" && a.fromPath
                                ? `${a.fromPath} → ${a.path}`
                                : a.path}
                            </span>
                          </button>
                          {bound && a.action !== "deleted" && (
                            <button
                              type="button"
                              className="btn-ghost shrink-0 px-1.5 py-1 text-meta"
                              disabled={saving !== null}
                              onClick={() => void saveOne(a.path)}
                              title="保存到项目资产"
                            >
                              {saving === a.path ? "…" : "保存"}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "workspace" && (
          <div className="p-3">
            <div className="mb-2 truncate px-1 font-mono text-meta text-ink-500" title={workspaceRoot}>
              {workspaceRoot || "未配置工作区"}
            </div>
            {tree ? (
              <FileTree node={tree} selected={previewPath} onOpen={onOpenFile} root />
            ) : (
              <p className="text-xs text-ink-500">无法读取工作区。请在设置中检查路径。</p>
            )}
          </div>
        )}
      </div>

      {(tab !== "debug" && selected && !previewPath) && <div className="min-h-0 flex-1 overflow-auto border-t border-ink-400 bg-panel">
        <div className="flex items-center justify-between px-3 py-2 text-meta text-ink-600">
          <span className="uppercase tracking-[0.14em]">预览</span>
          <div className="flex items-center gap-2">
            {selected && selected.before !== undefined && selected.after !== undefined && (
              <div className="flex overflow-hidden rounded-btn border border-ink-300">
                <button
                  type="button"
                  onClick={() => setMode("file")}
                  className={`px-2 py-0.5 text-meta ${
                    mode === "file" ? "bg-accent text-white" : "bg-panel text-ink-700 hover:bg-ink-200"
                  }`}
                >
                  文件
                </button>
                <button
                  type="button"
                  onClick={() => setMode("diff")}
                  className={`px-2 py-0.5 text-meta ${
                    mode === "diff" ? "bg-accent text-white" : "bg-panel text-ink-700 hover:bg-ink-200"
                  }`}
                >
                  对比
                </button>
              </div>
            )}
            {preview && <span className="normal-case tracking-normal">{formatBytes(preview.size)}</span>}
          </div>
        </div>
        <div className="h-[calc(100%-32px)] overflow-auto px-3 pb-3">
          {previewPath && workspaceRoot && (
            <div className="mb-2 break-all rounded border border-ink-300 bg-ink-100 p-2 text-xs text-ink-600">
              <div>本机工作区文件位置</div>
              <div className="mt-1 select-all font-mono">{`${workspaceRoot.replace(/\/+$/, "")}/${previewPath.replace(/^\/+/, "")}`}</div>
            </div>
          )}
          {!preview && !selected && <p className="text-xs text-ink-500">点击产物或工作区文件以预览。</p>}
          {mode === "diff" && selected?.before !== undefined && selected.after !== undefined && (
            <div>
              <div className="mb-2 font-mono text-meta text-accent">{selected.path}</div>
              <DiffView before={selected.before} after={selected.after} />
            </div>
          )}
          {mode === "file" && preview?.binary && <p className="text-xs text-ink-500">二进制文件，无法预览。</p>}
          {mode === "file" && preview && !preview.binary && (
            <div>
              <div className="mb-2 font-mono text-meta text-accent">{preview.path}</div>
              {isMarkdown(preview.path) ? (
                <MarkdownView text={preview.content} />
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-[13px] leading-5 text-ink-700">
                  {preview.content}
                </pre>
              )}
            </div>
          )}
          {mode === "file" && !preview && selected?.action === "deleted" && selected.before && (
            <div>
              <div className="mb-2 font-mono text-meta text-danger">{selected.path}（已删除）</div>
              <pre className="whitespace-pre-wrap font-mono text-[13px] leading-5 text-ink-700">
                {selected.before}
              </pre>
            </div>
          )}
        </div>
      </div>}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-2.5 text-xs font-medium ${
        active ? "border-b-2 border-accent text-ink-800" : "text-ink-600 hover:text-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function FileTree({
  node,
  selected,
  onOpen,
  root,
  depth = 0,
}: {
  node: WorkspaceNode;
  selected: string | null;
  onOpen: (path: string) => void;
  root?: boolean;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  if (node.type === "file") {
    return (
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        className={`flex w-full items-center gap-1.5 rounded-btn py-1 pr-2 text-left text-xs hover:bg-ink-200 ${
          selected === node.path ? "bg-accent-soft text-ink-800" : "text-ink-700"
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileText size={13} className="shrink-0 text-ink-600" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      {!root && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded-btn py-1 text-left text-xs text-ink-700 hover:bg-ink-200"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight size={12} className={`shrink-0 text-ink-600 transition ${open ? "rotate-90" : ""}`} />
          <Folder size={13} className="text-warning" />
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {(root || open) &&
        (node.children ?? []).map((child) => (
          <FileTree
            key={child.path}
            node={child}
            selected={selected}
            onOpen={onOpen}
            depth={root ? depth : depth + 1}
          />
        ))}
    </div>
  );
}
