import { SkillSelection, type SkillChoice } from "../components/SkillComposerInput";
import { useEffect, useRef, useState } from "react";
import { Plus, Clock3, X } from "lucide-react";
import "./cloud-automations.css";
import { cloudRequest } from "./cloud-api";
import {
  cronToPlan,
  describePlan,
  type SchedulePlan as Plan,
} from "@pig-agent/contracts";
import { draftPlan, editPlan } from "./automation-draft";
import { useDialog } from "../lib/use-dialog";
type Automation = {
  id: string;
  name: string;
  prompt: string;
  skillIds?: string[];
  enabled: boolean;
  requireApproval: boolean;
  networkPolicy: "ask" | "blocked";
  schedule: string | null;
  plan?: Plan;
  scheduleLabel?: string;
  executionTarget?: "cloud" | "local";
  timezone: string;
  misfirePolicy: "skip" | "once";
  nextFireAt?: string;
  lastError?: string;
};
type Run = { id: string; state: string; created_at: string; error?: string };
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const fresh = () => ({
  name: "",
  prompt: "",
  skillIds: [] as string[],
  planKind: "daily" as Plan["kind"],
  time: "09:00",
  cron: "",
  days: [1, 2, 3, 4, 5] as number[],
  executionTarget: "cloud" as "cloud" | "local",
  timezone: "Asia/Shanghai",
  misfirePolicy: "skip" as "skip" | "once",
  enabled: true,
  requireApproval: "default" as "default" | "review" | "auto",
  networkPolicy: "default" as "default" | "ask" | "blocked",
});
function planFromDraft(draft: ReturnType<typeof fresh>): Plan {
  return draftPlan({
    kind: draft.planKind,
    time: draft.time,
    days: draft.days,
    cron: draft.cron,
  });
}
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
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  useEffect(() => { let valid = true; void request("/v1/skills").then(result => { if (valid) setSkills(result.skills.map((s: SkillChoice & { displayName?: string }) => ({ ...s, name: s.displayName || s.name }))); }).catch(e => { if (valid) setError(String(e)); }); return () => { valid = false; }; }, []);
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
  const [firings, setFirings] = useState<
    Array<{ scheduled_at: string; outcome: string }>
  >([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"plans" | "history">("plans");
  const editor = useDialog<HTMLFormElement>(editing !== null, () => {
    if (!lock.current) setEditing(null);
  });
  const visible = rows.filter(
    (row) =>
      (!query.trim() ||
        `${row.name} ${row.prompt}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())) &&
      (status === "all" || row.enabled === (status === "enabled")),
  );
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
    if (!selected || view !== "history") return;
    let active = true;
    setHistoryLoading(true);
    setRuns([]);
    setFirings([]);
    const load = () =>
      request(`/v1/schedules/${selected}/history`)
        .then((data) => {
          if (active) {
            setRuns(data.runs);
            setFirings(data.firings || []);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setHistoryLoading(false);
        });
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, view]);
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
            skillIds: row.skillIds || [],
            planKind: editPlan(row.plan || cronToPlan(row.schedule)).kind,
            cron:
              row.plan?.kind === "custom" ? row.plan.cron : row.schedule || "",
            time: editPlan(row.plan || cronToPlan(row.schedule)).time,
            days: editPlan(row.plan || cronToPlan(row.schedule)).days,
            executionTarget:
              row.executionTarget === "local" ? "local" : "cloud",
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
          <h2 className="jd-duplicate-title">自动化</h2>
          <p>安排重复工作，在执行记录中查看每次结果。</p>
        </div>
        <button className="primary-button" onClick={() => edit()}>
          <Plus size={16} />
          新建自动化
        </button>
      </header>
      {error && editing === null && (
        <p role="alert" className="ca-error">
          {error}
        </p>
      )}
      {feedback && <p role="status">{feedback}</p>}
      <div className="ca-notice">
        云端计划由控制面调度，关闭网页后仍会执行。需要审批的操作会等待你确认。
      </div>
      <div className="ca-toolbar">
        <div className="ca-tabs" aria-label="自动化视图">
          <button
            aria-pressed={view === "plans"}
            onClick={() => setView("plans")}
          >
            我的计划 <small>{rows.length}</small>
          </button>
          <button
            aria-pressed={view === "history"}
            onClick={() => {
              setView("history");
              if (!selected && rows[0]) setSelected(rows[0].id);
            }}
          >
            执行记录
          </button>
        </div>
        {view === "plans" ? (
          <div className="ca-filters">
            <input
              aria-label="搜索自动化"
              placeholder="搜索任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="计划状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="enabled">已启用</option>
              <option value="paused">已暂停</option>
            </select>
            <button disabled={busy} onClick={() => void act(refresh)}>
              刷新
            </button>
          </div>
        ) : (
          <select
            aria-label="选择计划查看记录"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">选择计划</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {view === "plans" &&
        (loading ? (
          <p role="status">正在加载自动化…</p>
        ) : !rows.length ? (
          <div className="ca-empty">
            <Clock3 size={32} />
            <h3>还没有计划</h3>
            <p>可设为每天、每周，或仅手动执行。</p>
            <button onClick={() => edit()}>创建第一个自动化</button>
            <div className="ca-templates">
              {(
                [
                  [
                    "每日项目小结",
                    "整理任务中提供的项目资料，列出进展、风险和下一步；资料不足时明确说明，不编造。",
                  ],
                  [
                    "每周工作回顾",
                    "回顾任务中提供的工作记录，整理本周完成事项、待解决问题及下周计划。",
                  ],
                  [
                    "文档质量检查",
                    "检查任务中提供的文档，找出不一致、遗漏和不清晰的表述，输出可执行的修改建议。",
                  ],
                ] as const
              ).map(([name, prompt]) => (
                <button
                  key={name}
                  onClick={() => {
                    edit();
                    setDraft({
                      ...fresh(),
                      name,
                      prompt,
                      ...(name.startsWith("每周")
                        ? { planKind: "weekdays" as const, days: [5] }
                        : {}),
                    });
                  }}
                >
                  <strong>{name}</strong>
                  <span>{prompt}</span>
                  <em>使用模板 →</em>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ca-list">
            {!visible.length && (
              <div className="ca-empty">
                <h3>没有匹配的计划</h3>
                <button
                  onClick={() => {
                    setQuery("");
                    setStatus("all");
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
            {visible.map((row) => (
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
                  {row.scheduleLabel || row.schedule || "仅手动触发"} ·{" "}
                  {row.executionTarget === "local" ? "已登录的电脑" : "云端"} ·{" "}
                  {row.timezone}
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
                        setFeedback(
                          row.executionTarget === "local"
                            ? "已交给已登录的设备，同一时刻只有一台会执行"
                            : "任务已提交到云端",
                        );
                        if (d.remoteRunId) onRun(d.remoteRunId);
                        else {
                          setSelected(row.id);
                          setView("history");
                        }
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
                  <button
                    onClick={() => {
                      setSelected(row.id);
                      setView("history");
                    }}
                  >
                    运行记录
                  </button>
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
        ))}
      {editing !== null && (
        <div className="ca-overlay">
          <form
            ref={editor}
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "编辑自动化" : "新建自动化"}
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await request(
                  editing ? `/v1/schedules/${editing}` : "/v1/schedules",
                  editing ? "PATCH" : "POST",
                  {
                    name: draft.name,
                    prompt: draft.prompt,
                    skillIds: draft.skillIds,
                    timezone: draft.timezone,
                    misfirePolicy: draft.misfirePolicy,
                    enabled: draft.enabled,
                    executionTarget: draft.executionTarget,
                    plan: planFromDraft(draft),
                    requireApproval:
                      draft.requireApproval === "default"
                        ? undefined
                        : draft.requireApproval === "review",
                    networkPolicy:
                      draft.networkPolicy === "default"
                        ? undefined
                        : draft.networkPolicy,
                  },
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
            <p className="ca-subtitle">
              告诉 Agent 做什么、什么时候做。保存后可先手动执行一次。
            </p>
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
                rows={3}
                maxLength={20000}
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </label>
            <SkillSelection skills={skills} value={draft.skillIds} onChange={skillIds => setDraft({ ...draft, skillIds })} disabled={busy} />
            <label className="ca-half">
              计划
              <select
                aria-label="执行频率"
                value={draft.planKind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    planKind: e.target.value as Plan["kind"],
                  })
                }
              >
                <option value="manual">手动</option>
                <option value="hourly">每小时</option>
                <option value="daily">每天</option>
                <option value="weekdays">每周</option>
                <option value="custom">自定义 Cron</option>
              </select>
            </label>
            {draft.planKind === "custom" && (
              <label>
                Cron 表达式
                <input
                  aria-label="Cron 表达式"
                  required
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                />
                <small>保留已有自定义计划，按下方时区调度。</small>
              </label>
            )}
            {(draft.planKind === "daily" || draft.planKind === "weekdays") && (
              <label className="ca-half">
                时间
                <input
                  aria-label="执行时间"
                  type="time"
                  required
                  value={draft.time}
                  onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                />
              </label>
            )}
            {draft.planKind === "weekdays" && (
              <fieldset>
                <legend>星期</legend>
                <div className="ca-days">
                  {WEEKDAYS.map((label, day) => (
                    <label key={label}>
                      <input
                        type="checkbox"
                        checked={draft.days.includes(day)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            days: e.target.checked
                              ? [...draft.days, day].sort()
                              : draft.days.filter((item) => item !== day),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="ca-location">
              <strong>
                {draft.executionTarget === "local"
                  ? "已登录的电脑"
                  : "云端运行"}
              </strong>
              <p>
                {draft.executionTarget === "local"
                  ? "由已登录设备领取；同一时刻只有一台设备执行。"
                  : "由 Runner 执行，不依赖当前网页保持在线。"}
              </p>
            </div>
            <details className="ca-advanced">
              <summary>执行设置与安全策略</summary>
              <label>
                执行位置
                <select
                  aria-label="执行位置"
                  value={draft.executionTarget}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      executionTarget: e.target.value as "cloud" | "local",
                    })
                  }
                >
                  <option value="cloud">云端执行槽</option>
                  {draft.executionTarget === "local" && (
                    <option value="local">已登录的电脑</option>
                  )}
                </select>
              </label>
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
              <label>
                操作审批
                <select
                  value={draft.requireApproval}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      requireApproval: e.target.value as
                        | "default"
                        | "review"
                        | "auto",
                    })
                  }
                >
                  {!editing && (
                    <option value="default">
                      使用账号默认值（创建时保存）
                    </option>
                  )}
                  <option value="review">写入与命令需审批</option>
                  <option value="auto">沙箱内自动执行</option>
                </select>
              </label>
              <label>
                网络访问
                <select
                  value={draft.networkPolicy}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      networkPolicy: e.target.value as
                        | "default"
                        | "ask"
                        | "blocked",
                    })
                  }
                >
                  {!editing && (
                    <option value="default">
                      使用账号默认值（创建时保存）
                    </option>
                  )}
                  <option value="ask">HTTPS 逐次审批</option>
                  <option value="blocked">禁止网络访问</option>
                </select>
              </label>
              <p>
                审批档会等待人工确认，暂停执行计时，最多等待 30
                分钟。无人值守任务可选择沙箱内自动执行；这不会授权命令联网。
              </p>
            </details>
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
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button className="primary-button" disabled={busy}>
                {busy ? "正在保存…" : "保存自动化"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {view === "history" && (
        <div className="ca-history-panel">
          <section aria-label="自动化运行记录">
            <header>
              <h3>运行记录</h3>
              <button
                aria-label="返回计划列表"
                onClick={() => setView("plans")}
              >
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
            ) : firings.length ? (
              firings.map((f, i) => (
                <div className="ca-history" key={`${f.scheduled_at}:${i}`}>
                  <span>{new Date(f.scheduled_at).toLocaleString()}</span>
                  <span>
                    {{
                      waiting_device: "等待设备上线领取",
                      leased: "设备执行中",
                      succeeded: "已完成",
                      failed: "执行失败",
                      skipped: "已跳过",
                    }[f.outcome] || f.outcome}
                  </span>
                </div>
              ))
            ) : (
              <div className="ca-empty">
                <Clock3 size={28} />
                <h3>
                  {selected
                    ? "这个计划还没有执行记录"
                    : "选择一个计划查看执行记录"}
                </h3>
                <p>计划执行后，时间、状态和结果会显示在这里。</p>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
