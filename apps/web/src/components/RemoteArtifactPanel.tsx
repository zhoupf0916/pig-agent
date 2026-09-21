import { useEffect, useRef, useState } from "react";
import type {
  ArtifactPreview,
  RemoteArtifactRef,
} from "../lib/remote-artifacts";
import {
  listRemoteArtifacts,
  readRemoteArtifact,
  remoteArtifactUrl,
} from "../lib/remote-artifacts";
import { formatBytes, isMarkdown } from "../lib/format";
import { MarkdownView } from "./MarkdownView";
import { DiffView } from "./DiffView";
import type { AgentEvent } from "../types";

/** Remote previews are immutable run snapshots; importing creates a separate local review. */
export function RemoteArtifactPanel({
  runId,
  runState,
  sessionId,
  onOpenSession,
}: {
  runId?: string;
  runState?: string;
  sessionId?: string;
  onOpenSession?: (id: string) => void;
}) {
  const [selectedRun, setSelectedRun] = useState(runId);
  const [runs, setRuns] = useState<Array<{ id: string }>>([]);
  const [files, setFiles] = useState<RemoteArtifactRef[]>([]);
  const [selected, setSelected] = useState<RemoteArtifactRef | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState<"file" | "diff" | "logs">("file");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [logsError, setLogsError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSelectedRun(runId);
    setRuns(runId ? [{ id: runId }] : []);
  }, [runId, sessionId]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    void (async () => {
      const run = await fetch(
        `/api/remote/v1/runs/${encodeURIComponent(runId)}`,
        { signal: controller.signal },
      ).then((r) => (r.ok ? r.json() : null));
      if (!run?.conversation_id) return;
      const conversation = await fetch(
        `/api/remote/v1/conversations/${encodeURIComponent(run.conversation_id)}`,
        { signal: controller.signal },
      ).then((r) => (r.ok ? r.json() : null));
      if (!controller.signal.aborted && conversation?.runs)
        setRuns(conversation.runs);
    })().catch(() => {});
    return () => controller.abort();
  }, [runId, sessionId]);
  useEffect(() => {
    setEvents([]);
    setLogsError("");
    if (!selectedRun) return;
    const controller = new AbortController();
    void fetch(
      `/api/remote/v1/runs/${encodeURIComponent(selectedRun)}/eventlog`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw Error("日志读取失败，请刷新重试");
        return r.json();
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setEvents(data.events.map((row: { event: AgentEvent }) => row.event));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLogsError(String(e.message || e));
      });
    return () => controller.abort();
  }, [selectedRun, sessionId, refresh, runState]);
  useEffect(() => {
    setFiles([]);
    setSelected(null);
    setPreview(null);
    setError("");
    if (!selectedRun) return;
    const controller = new AbortController();
    setLoading(true);
    void listRemoteArtifacts(selectedRun, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setFiles(result);
          setSelected(result[0] ?? null);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message || e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selectedRun, sessionId, refresh, runState]);
  useEffect(() => {
    setPreview(null);
    setError("");
    setReading(false);
    if (!selected) return;
    const controller = new AbortController();
    setReading(true);
    void readRemoteArtifact(selected, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message || e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [selected]);
  // On a task/run switch React effects have not run yet. Do not paint the old
  // preview even for a frame; only identity-matching data can be rendered.
  const current =
    preview &&
    selected &&
    preview.runId === selectedRun &&
    preview.artifactId === selected.artifactId
      ? preview
      : null;
  const change = events
    .filter(
      (event): event is Extract<AgentEvent, { type: "artifact" }> =>
        event.type === "artifact" && event.artifact.path === selected?.path,
    )
    .at(-1)?.artifact;
  return (
    <aside
      className="resource-panel remote-artifact-panel flex h-full min-w-0 flex-col border-l border-ink-300 bg-panel"
      aria-label="远端成果检查器"
    >
      <header className="flex items-center justify-between gap-2 border-b border-ink-300 p-4">
        <p className="text-sm text-ink-600">远端快照 · 本机文件未被修改</p>
        <button
          className="btn-ghost"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          刷新
        </button>
      </header>
      <div className="border-b border-ink-300 p-4">
        <label
          className="mb-2 block text-xs text-ink-600"
          htmlFor="artifact-run"
        >
          所属运行 / 版本
        </label>
        <select
          id="artifact-run"
          className="input w-full text-sm"
          disabled={importing}
          value={selectedRun || ""}
          onChange={(e) => {
            // Reselecting the current version must keep its loaded content:
            // an unchanged run ID does not restart the fetch effect.
            if (e.target.value === selectedRun) return;
            setSelected(null);
            setPreview(null);
            setFiles([]);
            setEvents([]);
            setSelectedRun(e.target.value);
          }}
        >
          {!runs.length && <option value="">尚未开始运行</option>}
          {runs.map((run, i) => (
            <option key={run.id} value={run.id}>
              第 {i + 1} 次 · {run.id.slice(-8)}
              {run.id === runId ? "（最新）" : "（历史）"}
            </option>
          ))}
        </select>
      </div>
      <nav className="flex border-b border-ink-300" aria-label="成果视图">
        {(
          [
            ["file", "文件"],
            ["diff", "对比"],
            ["logs", "执行日志"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`flex-1 px-3 py-3 text-sm ${mode === value ? "border-b-2 border-accent text-accent" : "text-ink-600"}`}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {mode === "logs" ? (
          <section aria-label="当前运行日志">
            {logsError && (
              <p role="alert" className="text-sm text-danger">
                {logsError}
              </p>
            )}
            {!events.length && !logsError && (
              <p className="text-sm text-ink-600">此运行尚无日志。</p>
            )}
            {events.map((event, i) => (
              <details key={i} className="border-b border-ink-300 py-2">
                <summary className="cursor-pointer text-sm">
                  {i + 1}.{" "}
                  {event.type === "tool_start"
                    ? `执行 ${event.name}`
                    : event.type === "tool_end"
                      ? event.ok
                        ? "操作完成"
                        : "操作失败"
                      : event.type === "artifact"
                        ? `成果 ${event.artifact.path}`
                        : event.type === "error"
                          ? "运行错误"
                          : event.type === "message"
                            ? "消息"
                            : event.type}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">
                  {JSON.stringify(event, null, 2)}
                </pre>
              </details>
            ))}
          </section>
        ) : (
          <>
            {loading && (
              <p role="status" className="text-sm text-ink-600">
                正在读取远端成果…
              </p>
            )}
            {!loading && files.length === 0 && !error && (
              <p className="text-sm text-ink-600">
                此次运行尚无已保存成果。执行结束后刷新查看。
              </p>
            )}
            {files.length > 0 && (
              <ul className="mb-4 space-y-1">
                {files.map((file) => (
                  <li key={`${file.runId}:${file.artifactId}`}>
                    <button
                      className={`w-full rounded-btn p-2 text-left text-sm ${selected?.artifactId === file.artifactId ? "bg-accent-soft text-accent" : "hover:bg-ink-100"}`}
                      onClick={() => setSelected(file)}
                    >
                      {file.path}
                      <span className="ml-2 text-xs text-ink-600">
                        {formatBytes(file.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <div
                role="alert"
                className="rounded-btn border border-danger p-3 text-sm text-danger"
              >
                {error}
                <button
                  className="btn-ghost mt-2"
                  onClick={() => setRefresh((n) => n + 1)}
                >
                  重新读取
                </button>
              </div>
            )}
            {reading && (
              <p role="status" className="text-sm text-ink-600">
                正在预览远端文件…
              </p>
            )}
            {current && (
              <section
                aria-label="远端文件内容"
                className="border-t border-ink-300 pt-4"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-all text-sm font-medium">
                      {current.path}
                    </h3>
                    <p className="mt-1 text-xs text-ink-600">
                      远端运行 {current.runId.slice(-8)} 的已保存版本
                    </p>
                  </div>
                  <a
                    className="btn-ghost shrink-0"
                    href={remoteArtifactUrl(current)}
                    download
                  >
                    下载
                  </a>
                </div>
                {mode === "diff" ? (
                  change?.before !== undefined && change.after !== undefined ? (
                    <DiffView before={change.before} after={change.after} />
                  ) : (
                    <p className="text-sm text-ink-600">
                      此成果没有记录可用的变更前版本；请在“文件”中核验完整内容。
                    </p>
                  )
                ) : isMarkdown(current.path) ? (
                  <MarkdownView text={current.content} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6">
                    {current.content}
                  </pre>
                )}
                <details className="mt-4 text-xs text-ink-600">
                  <summary className="cursor-pointer">来源详情</summary>
                  <dl className="mt-2 space-y-1 break-all">
                    <dt>远端运行</dt>
                    <dd className="font-mono">{current.runId}</dd>
                    <dt>成果标识</dt>
                    <dd className="font-mono">{current.artifactId}</dd>
                  </dl>
                </details>
              </section>
            )}
          </>
        )}
      </div>
      {files.length > 0 && onOpenSession && (
        <footer className="border-t border-ink-300 p-4">
          <button
            className="btn-primary w-full"
            disabled={importing || loading}
            onClick={() => {
              const importingRun = selectedRun;
              setImporting(true);
              setError("");
              void fetch(
                `/api/remote/stage-artifacts/${encodeURIComponent(importingRun!)}`,
                { method: "POST" },
              )
                .then(async (r) => {
                  const data = await r.json();
                  if (!r.ok) throw Error(data.error || "无法导入");
                  if (mounted.current) onOpenSession(data.id);
                })
                .catch((e) => {
                  if (mounted.current) setError(String(e.message || e));
                })
                .finally(() => {
                  if (mounted.current) setImporting(false);
                });
            }}
          >
            {importing ? "正在生成变更单…" : "审阅并导入到本机"}
          </button>
          <p className="mt-2 text-xs leading-5 text-ink-600">
            创建独立的本机变更单；批准后才写入工作区。此远端版本保留不变。
          </p>
        </footer>
      )}
    </aside>
  );
}
