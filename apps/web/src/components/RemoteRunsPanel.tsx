import "./remote-runs.css";
import { remoteHash } from "../lib/hash";
import { useEffect, useState, useRef } from "react";
import type {
  CloudRunSummary,
  CloudArtifactSummary,
  CloudApproval,
} from "@pig-agent/contracts/cloud";
import { useDialog } from "../lib/use-dialog";
import { SharedProjectsPanel } from "./SharedProjectsPanel";
import { MarkdownView } from "./MarkdownView";
import { ExecutionJournal } from "./ExecutionJournal";
import { executionJournal } from "../lib/execution-journal";
import type { AgentEvent } from "../types";
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
  embedded = false,
  followSessionId,
  onClose,
  onOpenSession,
}: {
  runId?: string;
  embedded?: boolean;
  followSessionId?: string;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const dialog = useDialog(!embedded, onClose);
  const [mobileList, setMobileList] = useState(!runId);
  const [tab, setTab] = useState<"process" | "artifacts" | "approvals">(
    "process",
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (runId || embedded) {
      setSelected(runId || "");
      setMobileList(!runId);
    }
  }, [runId, embedded]);
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
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending("");
    }
  }
  const [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const [shared, setShared] = useState(false);
  const [runs, setRuns] = useState<CloudRunSummary[]>([]);
  const [selected, setSelected] = useState(runId || "");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [loadedDetail, setDetail] = useState<CloudRunSummary | null>(null);
  const detail = loadedDetail?.id === selected ? loadedDetail : null;
  const [events, setEvents] = useState<
    Array<{ seq: string; event: AgentEvent }>
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
          ) {
            setSelected(current.remoteRunId);
            if (
              embedded &&
              window.location.hash !== remoteHash(current.remoteRunId)
            ) {
              window.history.replaceState(
                null,
                "",
                remoteHash(current.remoteRunId),
              );
              window.dispatchEvent(new HashChangeEvent("hashchange"));
            }
          }
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
  }, [followSessionId, following, embedded]);
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
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label="远端运行记录"
      className={`remote-runs ${embedded ? "remote-runs-embedded" : "remote-runs-modal"}`}
    >
      <section className="remote-runs-surface">
        <header className="remote-runs-header">
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
            {embedded ? "返回工作台" : "关闭"}
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
              if (embedded) window.location.hash = remoteHash(id);
              setMobileList(false);
              setShared(false);
            }}
          />
        ) : (
          <div
            className={`remote-runs-body ${mobileList || !selected ? "show-list" : "show-detail"}`}
          >
            <aside className="remote-run-list">
              <div className="remote-run-filters">
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
                    if (embedded) window.location.hash = remoteHash(run.id);
                    setMobileList(false);
                  }}
                  className={`remote-run-row ${selected === run.id ? "selected" : ""}`}
                >
                  <div className="remote-run-title">{run.prompt}</div>
                  <div className="mt-1 text-xs text-ink-500">
                    {labels[run.state] || run.state} ·{" "}
                    {new Date(run.created_at).toLocaleString()}
                  </div>
                </button>
              ))}
            </aside>
            <article className="remote-run-detail">
              <button
                className="btn-ghost remote-list-toggle"
                onClick={() => setMobileList(true)}
              >
                ← 选择其他运行
              </button>
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
                            if (actionLock.current) return;
                            actionLock.current = true;
                            setStopping(true);
                            try {
                              await remote(`/v1/runs/${selected}/abort`, {
                                method: "POST",
                              });
                              const updated = await remote(
                                `/v1/runs/${selected}`,
                              );
                              if (
                                mounted.current &&
                                selectedRef.current === selected
                              )
                                setDetail(updated);
                            } catch (e) {
                              if (
                                mounted.current &&
                                selectedRef.current === selected
                              )
                                setError(String(e));
                            } finally {
                              actionLock.current = false;
                              if (mounted.current) setStopping(false);
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
                              if (mounted.current) onOpenSession?.(data.id);
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
                  <div className="remote-run-goal">
                    <h3 className="mb-2 text-xs font-medium text-ink-500">
                      任务目标
                    </h3>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {detail.prompt}
                    </p>
                    <details className="mt-3 text-xs text-ink-500">
                      <summary className="cursor-pointer">运行标识</summary>
                      <code className="break-all">{detail.id}</code>
                    </details>
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
              {detail && (
                <>
                  <nav className="remote-detail-tabs" aria-label="运行详情视图">
                    {(
                      [
                        [
                          "process",
                          "过程",
                          executionJournal(events.map((row) => row.event))
                            .length,
                        ],
                        ["artifacts", "成果", artifacts.length],
                        ["approvals", "审批", approvals.length],
                      ] as const
                    ).map(([value, label, count]) => (
                      <button
                        key={value}
                        aria-pressed={tab === value}
                        className={tab === value ? "selected" : ""}
                        onClick={() => setTab(value)}
                      >
                        {label}
                        <span>{count}</span>
                      </button>
                    ))}
                  </nav>
                  {tab !== "approvals" &&
                    approvals.some((a) => a.state === "pending") &&
                    !["succeeded", "failed", "cancelled"].includes(
                      detail.state,
                    ) && (
                      <div className="remote-approval-notice">
                        <span>此运行正在等待审批</span>
                        <button
                          className="btn-primary"
                          onClick={() => setTab("approvals")}
                        >
                          审阅操作
                        </button>
                      </div>
                    )}
                </>
              )}
              {tab === "approvals" && detail && !approvals.length && (
                <p className="remote-detail-empty">此运行暂无审批记录。</p>
              )}
              {tab === "approvals" &&
                detail &&
                approvals.map((approval) => (
                  <section
                    key={approval.id}
                    className="approval-card remote-history-approval"
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
                    <div className="operation-target">
                      <strong>
                        {String(
                          approval.args.path ??
                            approval.args.file_path ??
                            approval.tool,
                        )}
                      </strong>
                    </div>
                    {approval.args.command !== undefined && (
                      <pre className="approval-code">
                        {String(approval.args.command)}
                      </pre>
                    )}
                    {(approval.args.content ?? approval.args.new_string) !==
                      undefined && (
                      <div className="proposed-content">
                        <span>拟写入内容</span>
                        <pre>
                          {String(
                            approval.args.content ?? approval.args.new_string,
                          )}
                        </pre>
                      </div>
                    )}
                    <details>
                      <summary>高级：完整参数</summary>
                      <pre className="approval-code">
                        {JSON.stringify(approval.args, null, 2)}
                      </pre>
                    </details>
                    {approval.state === "pending" &&
                      detail &&
                      !["succeeded", "failed", "cancelled"].includes(
                        detail.state,
                      ) &&
                      detail.can_write !== false && (
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
                                    const updated = await remote(
                                      `/v1/runs/${selected}/approvals`,
                                    );
                                    if (
                                      mounted.current &&
                                      selectedRef.current === selected
                                    )
                                      setApprovals(updated.approvals);
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
              {tab === "process" && detail && (
                <h4 className="border-t border-ink-300 pt-4 text-sm font-medium">
                  执行过程{" "}
                  <span className="ml-2 text-xs font-normal text-ink-500">
                    工具操作 · 点击查看详情
                  </span>
                </h4>
              )}
              {tab === "process" && detail && !events.length && (
                <p className="text-xs text-ink-500">
                  {detail.state === "queued"
                    ? "任务已进入队列，等待 Runner 领取。"
                    : "尚无执行事件。"}
                </p>
              )}
              {tab === "process" && detail && (
                <>
                  {events
                    .filter(
                      ({ event }) =>
                        event.type === "message" &&
                        event.message.role === "assistant" &&
                        event.message.content.trim(),
                    )
                    .slice(-1)
                    .map(
                      ({ seq, event }) =>
                        event.type === "message" && (
                          <details
                            key={seq}
                            className="rounded-btn border border-ink-300 p-3 text-sm"
                          >
                            <summary className="cursor-pointer">
                              查看最终回复
                            </summary>
                            <MarkdownView text={event.message.content} />
                          </details>
                        ),
                    )}
                  <ExecutionJournal events={events.map((row) => row.event)} />
                </>
              )}
              {tab === "artifacts" && detail && !artifacts.length && (
                <p className="remote-detail-empty">
                  此运行尚无已保存成果。执行结束后会自动更新。
                </p>
              )}
              {tab === "artifacts" && detail && artifacts.length > 0 && (
                <div className="remote-run-artifacts">
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
                          if (mounted.current) onOpenSession?.(data.id);
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
