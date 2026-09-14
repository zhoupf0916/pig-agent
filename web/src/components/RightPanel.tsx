import { ChevronRight, FileCode, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import { artifactLabel, formatBytes, isMarkdown } from "../lib/format";
import type { Artifact, ArtifactAction, WorkspaceNode } from "../types";
import { DiffView } from "./DiffView";
import { MarkdownView } from "./MarkdownView";

type Tab = "artifacts" | "workspace";
type PreviewMode = "file" | "diff";

const GROUPS: ArtifactAction[] = ["created", "modified", "moved", "deleted"];

export function RightPanel({
  artifacts,
  tree,
  workspaceRoot,
  previewPath,
  preview,
  onOpenFile,
}: {
  artifacts: Artifact[];
  tree: WorkspaceNode | null;
  workspaceRoot: string;
  previewPath: string | null;
  preview: { path: string; content: string; binary: boolean; size: number } | null;
  onOpenFile: (path: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("artifacts");
  const [mode, setMode] = useState<PreviewMode>("file");
  const selected = artifacts.find((a) => a.path === previewPath);
  const grouped = useMemo(() => {
    return GROUPS.map((action) => ({
      action,
      items: artifacts.filter((a) => a.action === action),
    })).filter((g) => g.items.length > 0);
  }, [artifacts]);

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-white/5 bg-ink-900/70 xl:w-[360px]">
      <div className="flex border-b border-white/5">
        <TabButton active={tab === "artifacts"} onClick={() => setTab("artifacts")}>
          产物
          {artifacts.length > 0 && (
            <span className="ml-1 rounded-full bg-accent/20 px-1.5 text-[10px] text-sky-200">
              {artifacts.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === "workspace"} onClick={() => setTab("workspace")}>
          工作区
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "artifacts" && (
          <div className="p-3">
            {artifacts.length === 0 ? (
              <p className="px-1 pt-8 text-center text-xs text-ink-500">
                任务中新建、修改、移动或删除的文件会出现在这里。
              </p>
            ) : (
              <div className="space-y-3">
                {grouped.map((group) => (
                  <div key={group.action}>
                    <div className="mb-1 px-1 text-[10px] uppercase tracking-[0.14em] text-ink-500">
                      {artifactLabel(group.action)} · {group.items.length}
                    </div>
                    <ul className="space-y-1">
                      {group.items.map((a) => (
                        <li key={a.path}>
                          <button
                            type="button"
                            onClick={() => {
                              setMode(a.before !== undefined && a.after !== undefined ? "diff" : "file");
                              onOpenFile(a.path);
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-ink-800 ${
                              previewPath === a.path ? "bg-ink-800 text-white" : "text-ink-300"
                            }`}
                          >
                            <FileCode size={14} className="text-accent" />
                            <span className="min-w-0 flex-1 truncate">
                              {a.action === "moved" && a.fromPath
                                ? `${a.fromPath} → ${a.path}`
                                : a.path}
                            </span>
                          </button>
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
            <div className="mb-2 truncate px-1 font-mono text-[10px] text-ink-500" title={workspaceRoot}>
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

      <div className="min-h-[42%] border-t border-white/5">
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-ink-500">
          <span className="uppercase tracking-[0.14em]">预览</span>
          <div className="flex items-center gap-2">
            {selected && selected.before !== undefined && selected.after !== undefined && (
              <div className="flex rounded-md border border-white/10">
                <button
                  type="button"
                  onClick={() => setMode("file")}
                  className={`px-2 py-0.5 text-[10px] ${mode === "file" ? "bg-ink-800 text-white" : ""}`}
                >
                  文件
                </button>
                <button
                  type="button"
                  onClick={() => setMode("diff")}
                  className={`px-2 py-0.5 text-[10px] ${mode === "diff" ? "bg-ink-800 text-white" : ""}`}
                >
                  对比
                </button>
              </div>
            )}
            {preview && <span className="normal-case tracking-normal">{formatBytes(preview.size)}</span>}
          </div>
        </div>
        <div className="h-[calc(100%-32px)] overflow-auto px-3 pb-3">
          {!preview && !selected && <p className="text-xs text-ink-500">点击产物或工作区文件以预览。</p>}
          {mode === "diff" && selected?.before !== undefined && selected.after !== undefined && (
            <div>
              <div className="mb-2 font-mono text-[11px] text-accent">{selected.path}</div>
              <DiffView before={selected.before} after={selected.after} />
            </div>
          )}
          {mode === "file" && preview?.binary && <p className="text-xs text-ink-500">二进制文件，无法预览。</p>}
          {mode === "file" && preview && !preview.binary && (
            <div>
              <div className="mb-2 font-mono text-[11px] text-accent">{preview.path}</div>
              {isMarkdown(preview.path) ? (
                <MarkdownView text={preview.content} />
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-ink-300">
                  {preview.content}
                </pre>
              )}
            </div>
          )}
          {mode === "file" && !preview && selected?.action === "deleted" && selected.before && (
            <div>
              <div className="mb-2 font-mono text-[11px] text-red-300">{selected.path}（已删除）</div>
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-ink-300">
                {selected.before}
              </pre>
            </div>
          )}
        </div>
      </div>
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
        active ? "border-b-2 border-accent text-white" : "text-ink-500 hover:text-ink-300"
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
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs hover:bg-ink-800 ${
          selected === node.path ? "bg-ink-800 text-white" : "text-ink-300"
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <FileText size={13} className="shrink-0 text-ink-500" />
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
          className="flex w-full items-center gap-1 rounded-md py-1 text-left text-xs text-ink-300 hover:bg-ink-800"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight size={12} className={`shrink-0 transition ${open ? "rotate-90" : ""}`} />
          <Folder size={13} className="text-amber-200/80" />
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
