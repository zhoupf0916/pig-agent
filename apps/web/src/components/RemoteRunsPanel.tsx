import { useEffect, useState, useRef } from "react";
import type {
  CloudRunSummary,
  CloudArtifactSummary,
  CloudApproval,
} from "@pig-agent/contracts/cloud";
import { useDialog } from "../lib/use-dialog";
import { SharedProjectsPanel } from "./SharedProjectsPanel";
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
  const r = await fetch(`/api/remote${path}`, {
    signal: AbortSignal.timeout(15000),
    ...init,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
  return data;
}
export function RemoteRunsPanel({
  runId,
  followSessionId,
  onClose,
  onOpenSession,
}: {
  runId?: string;
  followSessionId?: string;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const dialog = useDialog(true, onClose);
  const [following, setFollowing] = useState(true);
  const [followError, setFollowError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [pending, setPending] = useState("");
  const actionLock = useRef(false);
  async function perform(key: string, action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending(key);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionLock.current = false;
      setPending("");
    }
  }
  const [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const [shared, setShared] = useState(false);
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
    if (!followSessionId || !following) {
      setFollowError("");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshCurrentRun() {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(followSessionId!)}`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const current = await response.json();
        if (!stopped) {
          setFollowError("");
          if (
            typeof current.remoteRunId === "string" &&
            current.remoteRunId &&
            !actionLock.current
          )
            setSelected(current.remoteRunId);
        }
      } catch (error) {
        if (!stopped)
          setFollowError(
            `当前会话运行同步失败：${error instanceof Error ? error.message : String(error)}`,
          );
      } finally {
        if (!stopped) timer = setTimeout(refreshCurrentRun, 2000);
      }
    }
    void refreshCurrentRun();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [followSessionId, following]);
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
        if (!stopped) {
          setRuns(data.runs);
          setListError("");
          setLoading(false);
        }
      } catch (e) {
        if (!stopped) {
          setListError(String(e));
          setLoading(false);
        }
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
    setError("");
    setDetailError("");
    setDetail(null);
    setEvents([]);
    setArtifacts([]);
    setApprovals([]);
    if (!selected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [run, log, files, review] = await Promise.all([
          remote(`/v1/runs/${selected}`),
          remote(`/v1/runs/${selected}/eventlog`),
          remote(`/v1/runs/${selected}/artifacts`),
          remote(`/v1/runs/${selected}/approvals`),
        ]);
        if (!stopped) {
          setDetail(run);
          setApprovals(review.approvals);
          setEvents(log.events);
          setArtifacts(files.artifacts);
          setDetailError("");
          setLastSync(new Date().toLocaleTimeString());
        }
      } catch (e) {
        if (!stopped) setDetailError(String(e));
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
  const visibleRuns = runs.filter(
    (run) =>
      (filter === "all" ||
        (filter === "active"
          ? ["queued", "preparing", "running", "cancelling"].includes(run.state)
          : run.state === filter)) &&
      `${run.prompt} ${run.id}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="远端运行记录"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-2 backdrop-blur-[2px] sm:p-4"
    >
      <section className="flex h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-card border border-ink-300 bg-panel shadow-xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-300 p-4">
          <div>
            <h2 className="font-medium">远端运行记录</h2>
            <p className="text-xs text-ink-500">
              状态来自控制面 · 关闭窗口不会停止任务
              {mode === "mock" ? " · 当前为模拟模型" : ""}
              {followSessionId && following ? " · 跟随当前会话" : ""}
            </p>
          </div>
          {followSessionId && !following && (
            <button
              className="btn-ghost"
              disabled={!!pending || stopping}
              onClick={() => {
                setFollowing(true);
                setShared(false);
              }}
            >
              回到当前会话
            </button>
          )}
          <button
            className="btn-ghost"
            disabled={!!pending || stopping}
            onClick={() => setShared(!shared)}
          >
            {shared ? "运行记录" : "组织与共享项目"}
          </button>
          <button
            className="btn-ghost shrink-0 whitespace-nowrap"
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        {(listError || detailError || followError) && (
          <div
            role="status"
            className="border-b border-ink-300 bg-warning-soft px-4 py-2 text-xs text-warning"
          >
            暂时无法同步控制面，正在自动重连。以下保留上次成功读取的数据。
            <details>
              <summary className="cursor-pointer">连接详情</summary>
              {detailError || listError || followError}
            </details>
          </div>
        )}
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {shared ? (
          <SharedProjectsPanel
            onRun={(id) => {
              setFollowing(false);
              setSelected(id);
              setShared(false);
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <aside className="max-h-52 w-full shrink-0 overflow-auto border-b border-ink-300 p-2 sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r">
              <div className="sticky top-0 z-10 space-y-2 bg-panel p-2">
                <input
                  className="field"
                  aria-label="搜索远端运行"
                  placeholder="搜索任务或运行 ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="field"
                  aria-label="筛选运行状态"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">全部运行 · {runs.length}</option>
                  <option value="active">进行中</option>
                  <option value="succeeded">已完成</option>
                  <option value="failed">失败</option>
                  <option value="cancelled">已取消</option>
                </select>
              </div>
              {loading && (
                <p role="status" className="p-3 text-sm text-ink-500">
                  正在读取运行记录…
                </p>
              )}
              {!loading && !runs.length && !listError && (
                <p className="p-3 text-sm text-ink-500">
                  暂无远端运行。可在会话或自动化中选择远端执行。
                </p>
              )}
              {!loading && runs.length > 0 && !visibleRuns.length && (
                <p className="p-3 text-sm text-ink-500">
                  没有匹配的运行。请调整搜索或状态筛选。
                </p>
              )}
              {visibleRuns.map((run) => (
                <button
                  key={run.id}
                  disabled={!!pending || stopping}
                  aria-current={selected === run.id ? "true" : undefined}
                  onClick={() => {
                    setFollowing(false);
                    setSelected(run.id);
                  }}
                  className={`mb-1 block w-full rounded-card p-3 text-left text-sm ${selected === run.id ? "bg-accent-soft" : "hover:bg-ink-100"}`}
                >
                  <div className="truncate">{run.prompt}</div>
                  <div className="mt-1 text-xs text-ink-500">
                    {labels[run.state] || run.state} ·{" "}
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
              {selected && !detail && !detailError && (
                <p role="status" className="text-sm text-ink-500">
                  正在读取任务、审批与执行日志…
                </p>
              )}
              {detail && (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${detail.state === "failed" ? "bg-danger-soft text-danger" : detail.state === "succeeded" ? "bg-success-soft text-success" : "bg-accent-soft text-accent"}`}
                      >
                        {labels[detail.state] || detail.state}
                      </span>
                      <p className="mt-2 text-xs text-ink-500">
                        {new Date(detail.created_at).toLocaleString()} · 更新于{" "}
                        {lastSync}
                      </p>
                    </div>
                    {detail.can_write !== false &&
                      ["queued", "preparing", "running"].includes(
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
                  {detail.conversation_id && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn-ghost"
                        disabled={detail.can_write === false || !!pending}
                        onClick={() =>
                          void perform("import", async () => {
                            try {
                              const r = await fetch(
                                `/api/remote/import/${detail.conversation_id}`,
                                { method: "POST" },
                              );
                              const data = await r.json();
                              if (!r.ok) throw Error(data.error);
                              onOpenSession?.(data.id);
                            } catch (e) {
                              setError(String(e));
                            }
                          })
                        }
                      >
                        {pending === "import"
                          ? "正在恢复会话…"
                          : "在工作台继续会话"}
                      </button>
                      {detail.state === "succeeded" && (
                        <a
                          className="btn-ghost"
                          href={`/api/remote/v1/conversations/${detail.conversation_id}/workspace/${detail.id}`}
                          download
                        >
                          下载工作区版本
                        </a>
                      )}
                    </div>
                  )}
                  <div className="rounded-card border border-ink-300 bg-ink-100 p-4">
                    <h3 className="mb-2 text-xs font-medium text-ink-500">
                      任务目标
                    </h3>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {detail.prompt}
                    </p>
                    <code className="mt-3 block break-all text-[11px] text-ink-500">
                      {detail.id}
                    </code>
                  </div>
                  {detail.can_write === false && (
                    <p className="text-xs text-ink-500">
                      只读权限：可查看过程和下载成果。继续会话与审批需要项目编辑权限。
                    </p>
                  )}
                  {detail.error && (
                    <p role="alert" className="text-danger">
                      {detail.error}
                    </p>
                  )}
                </>
              )}
              {approvals.map((approval) => (
                <section
                  key={approval.id}
                  className="rounded-card border border-ink-300 p-3 space-y-2 text-sm"
                >
                  <h4 className="font-medium">
                    云端操作审批 · {approval.tool}
                  </h4>
                  <p>
                    {
                      {
                        pending: "等待审批，尚未执行；等待计入容器运行时限",
                        approved:
                          detail &&
                          ["succeeded", "failed", "cancelled"].includes(
                            detail.state,
                          )
                            ? "已批准，但运行已结束；此授权未被执行器领取"
                            : "已批准，等待执行器领取",
                        rejected: "已拒绝",
                        consumed: "授权已领取，执行结果请查看工具日志",
                        expired: "运行已结束，旧审批已失效",
                      }[approval.state]
                    }
                  </p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(approval.args, null, 2)}
                  </pre>
                  {approval.state === "pending" &&
                    detail?.can_write !== false && (
                      <div className="flex gap-2">
                        {(["approve", "reject"] as const).map((decision) => (
                          <button
                            className="btn-ghost"
                            key={decision}
                            disabled={!!pending}
                            onClick={() =>
                              void perform(approval.id, async () => {
                                try {
                                  await remote(
                                    `/v1/runs/${selected}/approvals/${approval.id}/decision`,
                                    {
                                      method: "POST",
                                      headers: {
                                        "Content-Type": "application/json",
                                      },
                                      body: JSON.stringify({ decision }),
                                    },
                                  );
                                  setApprovals(
                                    (
                                      await remote(
                                        `/v1/runs/${selected}/approvals`,
                                      )
                                    ).approvals,
                                  );
                                } catch (e) {
                                  setError(String(e));
                                }
                              })
                            }
                          >
                            {decision === "approve"
                              ? "批准此操作"
                              : "拒绝并结束本轮"}
                          </button>
                        ))}
                      </div>
                    )}
                </section>
              ))}
              {detail && (
                <h4 className="border-t border-ink-300 pt-4 text-sm font-medium">
                  执行过程{" "}
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    回复与工具日志
                  </span>
                </h4>
              )}
              {detail && !events.length && (
                <p className="text-xs text-ink-500">
                  {detail.state === "queued"
                    ? "任务已进入队列，等待 Runner 领取。"
                    : "尚无执行事件。"}
                </p>
              )}
              {events.map(({ seq, event }) =>
                event.type === "message" && event.message?.content?.trim() ? (
                  <div key={seq} className="rounded-card bg-ink-100 p-3">
                    <MarkdownView text={event.message?.content || ""} />
                  </div>
                ) : event.type === "tool_end" ? (
                  <details
                    key={seq}
                    className="rounded-card border border-ink-300 p-3 text-xs"
                  >
                    <summary className="cursor-pointer font-medium">
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
                  <button
                    className="btn-ghost mb-2"
                    disabled={!!pending}
                    onClick={() =>
                      void perform("artifacts", async () => {
                        try {
                          const r = await fetch(
                            `/api/remote/stage-artifacts/${selected}`,
                            { method: "POST" },
                          );
                          const data = await r.json();
                          if (!r.ok) throw Error(data.error);
                          onOpenSession?.(data.id);
                        } catch (e) {
                          setError(String(e));
                        }
                      })
                    }
                  >
                    审阅导入到本地（批准后写入）
                  </button>
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
        )}
      </section>
    </div>
  );
}
