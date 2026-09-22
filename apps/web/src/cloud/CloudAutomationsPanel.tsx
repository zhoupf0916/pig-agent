import { useEffect, useRef, useState } from "react";
import { Plus, Clock3, X } from "lucide-react";
import "./cloud-automations.css";
import { cloudRequest } from "./cloud-api";
type Automation = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  requireApproval: boolean;
  networkPolicy: "ask" | "blocked";
  schedule: string | null;
  timezone: string;
  misfirePolicy: "skip" | "once";
  nextFireAt?: string;
  lastError?: string;
};
type Run = { id: string; state: string; created_at: string; error?: string };
const fresh = () => ({
  name: "",
  prompt: "",
  schedule: "0 9 * * *",
  timezone: "Asia/Shanghai",
  misfirePolicy: "skip" as "skip" | "once",
  enabled: true,
  requireApproval: "default" as "default" | "review" | "auto",
  networkPolicy: "default" as "default" | "ask" | "blocked",
});
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  return cloudRequest(
    path,
    method,
    body,
    key ? { "Idempotency-Key": key } : undefined,
  );
}
export function CloudAutomationsPanel({
  onRun,
}: {
  onRun: (id: string) => void;
}) {
  const [rows, setRows] = useState<Automation[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(fresh),
    [selected, setSelected] = useState(""),
    [runs, setRuns] = useState<Run[]>([]),
    [historyLoading, setHistoryLoading] = useState(false);
  const manualKeys = useRef(new Map<string, string>());
  const lock = useRef(false),
    generation = useRef(0),
    requestKey = useRef(crypto.randomUUID());
  async function refresh() {
    const data = await request("/v1/schedules");
    setRows(data.automations);
  }
  useEffect(() => {
    let active = true;
    request("/v1/schedules")
      .then((data) => {
        if (active) setRows(data.automations);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setHistoryLoading(true);
    setRuns([]);
    request(`/v1/schedules/${selected}/history`)
      .then((data) => {
        if (active) setRuns(data.runs);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);
  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    const g = generation.current;
    try {
      await action();
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      lock.current = false;
      if (g === generation.current) setBusy(false);
    }
  }
  function edit(row?: Automation) {
    requestKey.current = crypto.randomUUID();
    setDraft(
      row
        ? {
            name: row.name,
            prompt: row.prompt,
            schedule: row.schedule || "",
            timezone: row.timezone,
            misfirePolicy: row.misfirePolicy,
            enabled: row.enabled,
            requireApproval: row.requireApproval === false ? "auto" : "review",
            networkPolicy: row.networkPolicy || "ask",
          }
        : fresh(),
    );
    setEditing(row?.id || "");
    setError("");
  }
  const label: Record<string, string> = {
    queued: "排队中",
    preparing: "准备中",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    cancelling: "正在取消",
  };
  return (
    <section className="cloud-automations" aria-label="自动化">
      <header>
        <div>
          <h2>自动化</h2>
          <p>让 Agent 按计划在云端执行，离开工作台也能继续。</p>
        </div>
        <button className="primary-button" onClick={() => edit()}>
          <Plus size={16} />
          新建自动化
        </button>
      </header>
      {error && (
        <p role="alert" className="ca-error">
          {error}
        </p>
      )}
      {feedback && <p role="status">{feedback}</p>}
      {loading ? (
        <p role="status">正在加载自动化…</p>
      ) : !rows.length ? (
        <div className="ca-empty">
          <Clock3 size={32} />
          <h3>把重复工作交给 Agent</h3>
          <p>创建一个计划，例如每天整理信息，或保存一个手动执行的任务。</p>
          <button onClick={() => edit()}>创建第一个自动化</button>
        </div>
      ) : (
        <div className="ca-list">
          {rows.map((row) => (
            <article key={row.id}>
              <div className="ca-row">
                <h3>{row.name}</h3>
                <span>
                  {row.enabled
                    ? row.schedule
                      ? "计划已启用"
                      : "手动执行"
                    : "已暂停"}
                </span>
              </div>
              <p className="ca-prompt">{row.prompt}</p>
              <small>
                {row.schedule || "仅手动触发"} · {row.timezone}
                {row.nextFireAt
                  ? ` · 下次 ${new Date(row.nextFireAt).toLocaleString()}`
                  : ""}
              </small>
              {row.lastError && <p role="alert">{row.lastError}</p>}
              <div className="ca-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    const key =
                      manualKeys.current.get(row.id) || crypto.randomUUID();
                    manualKeys.current.set(row.id, key);
                    const intent = generation.current;
                    void act(async () => {
                      const d = await request(
                        `/v1/schedules/${row.id}/run`,
                        "POST",
                        {},
                        key,
                      );
                      manualKeys.current.delete(row.id);
                      if (intent !== generation.current) return;
                      setFeedback("任务已提交到云端");
                      onRun(d.remoteRunId);
                    });
                  }}
                >
                  立即执行
                </button>
                <button onClick={() => edit(row)}>编辑</button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await request(`/v1/schedules/${row.id}`, "PATCH", {
                        enabled: !row.enabled,
                      });
                      await refresh();
                      setFeedback(row.enabled ? "已暂停计划" : "已启用计划");
                    })
                  }
                >
                  {row.enabled ? "暂停" : "启用"}
                </button>
                <button onClick={() => setSelected(row.id)}>运行记录</button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `删除自动化「${row.name}」？运行记录仍会保留。`,
                      )
                    )
                      void act(async () => {
                        await request(`/v1/schedules/${row.id}`, "DELETE");
                        await refresh();
                        setFeedback("自动化已删除");
                      });
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing !== null && (
        <div className="ca-overlay">
          <form
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "编辑自动化" : "新建自动化"}
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await request(
                  editing ? `/v1/schedules/${editing}` : "/v1/schedules",
                  editing ? "PATCH" : "POST",
                  { ...draft, requireApproval:draft.requireApproval === "default" ? undefined : draft.requireApproval === "review", networkPolicy:draft.networkPolicy === "default" ? undefined : draft.networkPolicy, schedule: draft.schedule.trim() || null },
                  requestKey.current,
                );
                await refresh();
                setEditing(null);
                setFeedback("自动化已保存");
              });
            }}
          >
            <header>
              <h3>{editing ? "编辑自动化" : "新建自动化"}</h3>
              <button
                type="button"
                disabled={busy}
                aria-label="关闭自动化编辑"
                onClick={() => setEditing(null)}
              >
                <X size={18} />
              </button>
            </header>
            <label>
              名称
              <input
                required
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              任务要求
              <textarea
                required
                rows={5}
                maxLength={20000}
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </label>
            <label>
              执行计划（Cron）
              <input
                aria-describedby="cron-help"
                value={draft.schedule}
                onChange={(e) =>
                  setDraft({ ...draft, schedule: e.target.value })
                }
              />
            </label>
            <small id="cron-help">
              例如 0 9 * * * 表示每天9点；留空则仅手动执行。
            </small>
            <label>
              时区
              <input
                required
                value={draft.timezone}
                onChange={(e) =>
                  setDraft({ ...draft, timezone: e.target.value })
                }
              />
            </label>
            <label>
              错过计划时
              <select
                value={draft.misfirePolicy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    misfirePolicy: e.target.value as "skip" | "once",
                  })
                }
              >
                <option value="skip">跳过</option>
                <option value="once">恢复后补执行一次</option>
              </select>
            </label>
            <label>操作审批
              <select value={draft.requireApproval} onChange={e=>setDraft({...draft,requireApproval:e.target.value as "default"|"review"|"auto"})}>
                {!editing && <option value="default">使用账号默认值（创建时保存）</option>}
                <option value="review">写入与命令需审批</option><option value="auto">沙箱内自动执行</option>
              </select>
            </label>
            <label>网络访问
              <select value={draft.networkPolicy} onChange={e=>setDraft({...draft,networkPolicy:e.target.value as "default"|"ask"|"blocked"})}>
                {!editing && <option value="default">使用账号默认值（创建时保存）</option>}
                <option value="ask">HTTPS 逐次审批</option><option value="blocked">禁止网络访问</option>
              </select>
            </label>
            <p>审批档会等待人工确认，等待计入运行时限。无人值守任务可选择沙箱内自动执行；这不会授权命令联网。</p>
            <label className="ca-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              启用计划
            </label>
            <p>运行由控制面调度，使用远端原生沙箱。变更会影响后续触发。</p>
            {error && (
              <p role="alert" className="ca-error">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={busy}>
              {busy ? "正在保存…" : "保存自动化"}
            </button>
          </form>
        </div>
      )}
      {selected && (
        <div className="ca-overlay">
          <section role="dialog" aria-modal="true" aria-label="自动化运行记录">
            <header>
              <h3>运行记录</h3>
              <button aria-label="关闭运行记录" onClick={() => setSelected("")}>
                <X size={18} />
              </button>
            </header>
            {historyLoading ? (
              <p role="status">正在加载…</p>
            ) : runs.length ? (
              runs.map((run) => (
                <button
                  className="ca-history"
                  key={run.id}
                  onClick={() => onRun(run.id)}
                >
                  <span>{new Date(run.created_at).toLocaleString()}</span>
                  <span>{label[run.state] || run.state}</span>
                  {run.error && <small>{run.error}</small>}
                </button>
              ))
            ) : (
              <p>还没有运行记录。</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
