import { useEffect, useState } from "react";
import type {
  CloudRunSummary,
  CloudArtifactSummary,
} from "@pig-agent/contracts/cloud";
import { MarkdownView } from "./MarkdownView";
const labels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备容器",
  running: "执行中",
  cancelling: "正在取消",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
};
async function remote(path: string, init?: RequestInit) {
  const r = await fetch(`/api/remote${path}`, init);
  const data = await r.json();
  if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
  return data;
}
export function RemoteRunsPanel({
  runId,
  onClose,
}: {
  runId?: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<CloudRunSummary[]>([]);
  const [selected, setSelected] = useState(runId || "");
  const [detail, setDetail] = useState<CloudRunSummary | null>(null);
  const [events, setEvents] = useState<
    Array<{
      seq: string;
      event: {
        type: string;
        message?: { content: string };
        output?: string;
        name?: string;
        ok?: boolean;
      };
    }>
  >([]);
  const [artifacts, setArtifacts] = useState<CloudArtifactSummary[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("");
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    void remote("/health")
      .then((d) => setMode(d.modelMode))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await remote("/v1/runs");
        if (!stopped) setRuns(data.runs);
      } catch (e) {
        if (!stopped) setError(String(e));
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2500);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    setDetail(null);
    setEvents([]);
    setArtifacts([]);
    if (!selected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [run, log, files] = await Promise.all([
          remote(`/v1/runs/${selected}`),
          remote(`/v1/runs/${selected}/eventlog`),
          remote(`/v1/runs/${selected}/artifacts`),
        ]);
        if (!stopped) {
          setDetail(run);
          setEvents(log.events);
          setArtifacts(files.artifacts);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="远端运行记录"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
    >
      <section className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-card border border-ink-300 bg-panel shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-300 p-4">
          <div>
            <h2 className="font-medium">远端运行记录</h2>
            <p className="text-xs text-ink-500">
              状态来自控制面 · 关闭窗口不会停止任务
              {mode === "mock" ? " · 当前为模拟模型" : ""}
            </p>
          </div>
          <button className="btn-ghost shrink-0 whitespace-nowrap" onClick={onClose}>
            关闭
          </button>
        </header>
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="max-h-36 w-full shrink-0 overflow-auto border-b border-ink-300 p-2 sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
            {!runs.length && (
              <p className="p-3 text-sm text-ink-500">
                暂无远端运行。可在会话或自动化中选择远端执行。
              </p>
            )}
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelected(run.id)}
                className={`mb-1 block w-full rounded-card p-3 text-left text-sm ${selected === run.id ? "bg-accent-soft" : "hover:bg-ink-100"}`}
              >
                <div className="truncate">{run.prompt}</div>
                <div className="mt-1 text-xs text-ink-500">
                  {labels[run.state]} ·{" "}
                  {new Date(run.created_at).toLocaleString()}
                </div>
              </button>
            ))}
          </aside>
          <article className="min-w-0 flex-1 space-y-4 overflow-auto p-5">
            {!selected && (
              <p className="text-sm text-ink-500">
                选择一条运行查看回复、工具日志和成果。
              </p>
            )}
            {detail && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{labels[detail.state]}</h3>
                  {["queued", "preparing", "running"].includes(
                    detail.state,
                  ) && (
                    <button
                      className="btn-ghost"
                      disabled={stopping}
                      onClick={async () => {
                        setStopping(true);
                        try {
                          await remote(`/v1/runs/${selected}/abort`, {
                            method: "POST",
                          });
                          setDetail(await remote(`/v1/runs/${selected}`));
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setStopping(false);
                        }
                      }}
                    >
                      {stopping ? "提交取消…" : "停止任务"}
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm">{detail.prompt}</p>
                {detail.error && (
                  <p role="alert" className="text-danger">
                    {detail.error}
                  </p>
                )}
              </>
            )}
            {events.map(({ seq, event }) =>
              event.type === "message" ? (
                <div key={seq} className="rounded-card bg-ink-100 p-3">
                  <MarkdownView text={event.message?.content || ""} />
                </div>
              ) : event.type === "tool_end" ? (
                <details key={seq} className="text-xs">
                  <summary>
                    {event.ok ? "✓" : "✕"} {event.name}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-all">
                    {event.output}
                  </pre>
                </details>
              ) : null,
            )}
            {artifacts.length > 0 && (
              <div className="border-t border-ink-300 pt-3">
                <h4 className="mb-2 text-sm font-medium">成果文件</h4>
                {artifacts.map((file) => (
                  <a
                    key={file.id}
                    className="btn-ghost mr-2 inline-block"
                    href={`/api/remote/v1/runs/${selected}/artifacts/${file.id}`}
                    download
                  >
                    {file.path}
                  </a>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
