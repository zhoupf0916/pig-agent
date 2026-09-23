import type { AccountBudget } from "@pig-agent/contracts/cloud";
import { ExtensionsPanel } from "../components/ExtensionsPanel";
import { useEffect, useState, useRef } from "react";
import { cloudRequest as api } from "./cloud-api";
export function CloudSettingsPanel() {
  const [budget, setBudget] = useState<AccountBudget | null>(null);
  useEffect(() => {
    void api("/v1/usage")
      .then(setBudget)
      .catch(() => {});
  }, []);
  const [section, setSection] = useState<"preferences" | "extensions">(() =>
    location.hash.endsWith("/extensions") ? "extensions" : "preferences",
  );
  const [value, setValue] = useState<{
      name?: string;
      networkPolicy: "ask" | "blocked";
      requireApproval: boolean;
      memoryEnabled: boolean;
      timezone?: string;
      defaultRunTarget?: "cloud" | "local";
    } | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void api("/v1/settings")
      .then((v) => {
        if (active) setValue(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  return (
    <section className="cloud-page">
      <h2 className="jd-duplicate-title">设置</h2>
      <nav className="cloud-settings-tabs" aria-label="设置分类">
        <button
          type="button"
          aria-pressed={section === "preferences"}
          onClick={() => setSection("preferences")}
        >
          偏好设置
        </button>
        <button
          type="button"
          aria-pressed={section === "extensions"}
          onClick={() => setSection("extensions")}
        >
          扩展与 MCP
        </button>
      </nav>
      {section === "extensions" && (
        <ExtensionsPanel mode="cloud" request={api} />
      )}
      <div hidden={section !== "preferences"}>
        {budget && (
          <section className="cloud-budget" aria-label="账号模型额度">
            <h3>模型额度</h3>
            <strong>
              可用 ¥
              {Math.max(
                0,
                (Number(budget.budget_micros) -
                  Number(budget.spent_micros) -
                  Number(budget.reserved_micros)) /
                  1e6,
              ).toFixed(4)}
            </strong>
            <p>
              总预算 ¥{(Number(budget.budget_micros) / 1e6).toFixed(2)} · 已用 ¥
              {(Number(budget.spent_micros) / 1e6).toFixed(4)} · 预留 ¥
              {(Number(budget.reserved_micros) / 1e6).toFixed(4)}
            </p>
            <small>
              新账号一次性 2 元；按平台人民币费率和模型返回的 token
              用量结算，不是固定 token
              数。调用前预留，异常未返回用量时保留预留金额。额度不足请联系管理员。
            </small>
            <p>
              今日调用 {budget.calls_today} / {budget.daily_call_limit}（UTC）
            </p>
          </section>
        )}

        <p className="muted">对新任务生效。进行中的任务不变。</p>
        {error && <p role="alert">{error}</p>}
        {!value ? (
          error ? (
            <button onClick={() => setReload((v) => v + 1)}>
              重新加载设置
            </button>
          ) : (
            <p role="status">正在读取设置…</p>
          )
        ) : (
          <form
            className="cloud-form settings-grid"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              setSaved("");
              try {
                setValue(
                  await api("/v1/settings", "PUT", {
                    displayName: value.name,
                    networkPolicy: value.networkPolicy,
                    requireApproval: value.requireApproval,
                    memoryEnabled: value.memoryEnabled,
                    timezone: value.timezone || "Asia/Shanghai",
                    defaultRunTarget: value.defaultRunTarget || "cloud",
                  }),
                );
                setSaved("设置已保存，下一次新任务生效。");
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              显示名称
              <input
                disabled={busy}
                maxLength={40}
                value={value.name || ""}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
              <small>协作中显示的名字。</small>
            </label>
            <label>
              时区
              <select
                disabled={busy}
                value={value.timezone || "Asia/Shanghai"}
                onChange={(e) =>
                  setValue({ ...value, timezone: e.target.value })
                }
              >
                {[
                  ["Asia/Shanghai", "北京时间"],
                  ["Asia/Tokyo", "东京"],
                  ["Asia/Singapore", "新加坡"],
                  ["Europe/London", "伦敦"],
                  ["America/New_York", "纽约"],
                  ["America/Los_Angeles", "洛杉矶"],
                  ["UTC", "UTC"],
                ].map(([zone, label]) => (
                  <option key={zone} value={zone}>
                    {label}
                  </option>
                ))}
              </select>
              <small>计划使用此时区。</small>
            </label>
            <label>
              新计划默认在哪执行
              <select
                disabled={busy}
                value={value.defaultRunTarget || "cloud"}
                onChange={(e) =>
                  setValue({
                    ...value,
                    defaultRunTarget: e.target.value as "cloud" | "local",
                  })
                }
              >
                <option value="cloud">云端执行槽</option>
                <option value="local">已登录的电脑</option>
              </select>
              <small>仅新计划。</small>
            </label>
            <label>
              默认网络访问
              <select
                disabled={busy}
                value={value.networkPolicy}
                onChange={(e) =>
                  setValue({
                    ...value,
                    networkPolicy: e.target.value as "ask" | "blocked",
                  })
                }
              >
                <option value="ask">逐次申请 HTTPS 读取</option>
                <option value="blocked">禁止网络访问</option>
              </select>
              <small>
                HTTPS 读取和 MCP 调用逐次批准，不开放命令联网或安装依赖。
              </small>
            </label>
            <label>
              默认操作审批
              <select
                disabled={busy}
                value={value.requireApproval ? "review" : "auto"}
                onChange={(e) =>
                  setValue({
                    ...value,
                    requireApproval: e.target.value === "review",
                  })
                }
              >
                <option value="review">写入与命令需审批</option>
                <option value="auto">沙箱内自动执行</option>
              </select>
              <small>
                个人项目默认沙箱内直接执行。协同项目和外部 MCP
                调用始终逐次审批。
              </small>
            </label>
            <label className="cloud-check settings-span">
              <input
                disabled={busy}
                type="checkbox"
                checked={value.memoryEnabled}
                onChange={(e) =>
                  setValue({ ...value, memoryEnabled: e.target.checked })
                }
              />
              新个人任务使用我的记忆
            </label>
            <p className="muted settings-span">
              私人记忆不会注入项目协同任务。
            </p>
            <div className="cloud-note settings-span">
              执行环境：远端 Runner 的固定执行槽，操作系统沙箱打不开就拒绝。
              <br />
              模型渠道、额度和 Worker 数量在管理后台配置，这里改不了。
              <br />
              协同项目的写入和命令始终逐次审批，不受上面的自动档影响。
            </div>
            <button className="primary-button settings-span" disabled={busy}>
              {busy ? "保存中…" : "保存设置"}
            </button>
            {saved && (
              <p className="settings-span" role="status">
                {saved}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
export function CloudMemoryPanel() {
  const [items, setItems] = useState<Array<{ id: string; content: string }>>(
      [],
    ),
    [content, setContent] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const refreshVersion = useRef(0);
  async function refresh() {
    const version = ++refreshVersion.current;
    try {
      const data = await api("/v1/memory");
      if (version === refreshVersion.current) setItems(data.memories);
    } catch (e) {
      if (version === refreshVersion.current) setError(String(e));
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      refreshVersion.current++;
    };
  }, []);
  return (
    <section className="cloud-page">
      <h2 className="jd-duplicate-title">记忆</h2>
      <p className="muted">仅用于个人任务。</p>
      <form
        className="cloud-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/v1/memory", "POST", { content });
            setContent("");
            await refresh();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          添加记忆
          <textarea
            required
            maxLength={2000}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例如：输出报告时先写结论，再给依据。"
          />
        </label>
        <button className="primary-button" disabled={busy || !content.trim()}>
          保存记忆
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>正在加载…</p>
      ) : !items.length ? (
        <div className="cloud-note">还没有记忆。从一条常用偏好开始。</div>
      ) : (
        items.map((i) => (
          <article className="cloud-card" key={i.id}>
            <p>{i.content}</p>
            <button
              onClick={async () => {
                try {
                  await api(`/v1/memory/${i.id}`, "DELETE");
                  await refresh();
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              删除
            </button>
          </article>
        ))
      )}
    </section>
  );
}
export function CloudSearchPanel({
  onConversation,
}: {
  onConversation: (id: string) => void;
}) {
  const [q, setQ] = useState(
      () =>
        new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "",
    ),
    [results, setResults] = useState<
      Array<{ conversationId: string; title: string; snippet: string }>
    >([]),
    [searched, setSearched] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const initial =
      new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
    if (!initial) return;
    let alive = true;
    setBusy(true);
    void api(`/v1/search?q=${encodeURIComponent(initial)}`)
      .then((data) => {
        if (!alive) return;
        setQ(initial);
        setResults(data.results);
        setSearched(true);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="cloud-page">
      <h2 className="jd-duplicate-title">搜索</h2>
      <p className="muted">任务和消息。</p>
      <form
        className="cloud-search"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            setResults(
              (await api(`/v1/search?q=${encodeURIComponent(q)}`)).results,
            );
            setSearched(true);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          aria-label="搜索任务和消息"
          required
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入关键词"
        />
        <button disabled={busy} className="primary-button">
          {busy ? "搜索中…" : "搜索"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {searched && !results.length && <p>没有找到匹配的任务或消息。</p>}
      {results.map((r, i) => (
        <button
          key={i}
          className="cloud-card cloud-result"
          onClick={() => onConversation(r.conversationId)}
        >
          <strong>{r.title}</strong>
          <span>{r.snippet}</span>
        </button>
      ))}
    </section>
  );
}
export function CloudRunsPanel({ onRun }: { onRun: (id: string) => void }) {
  const [runs, setRuns] = useState<
      Array<{ id: string; prompt: string; state: string; created_at: string }>
    >([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await api("/v1/runs");
        if (active) setRuns(data.runs);
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const labels: Record<string, string> = {
    queued: "排队中",
    preparing: "准备中",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已停止",
    cancelling: "正在停止",
  };
  return (
    <section className="cloud-page">
      <h2 className="jd-duplicate-title">远端记录</h2>
      <p className="muted">执行记录。</p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>正在加载…</p>
      ) : runs.length ? (
        runs.map((r) => (
          <button
            key={r.id}
            className="cloud-card cloud-result"
            onClick={() => onRun(r.id)}
          >
            <strong>{r.prompt || r.id}</strong>
            <span>
              {labels[r.state] || r.state} ·{" "}
              {new Date(r.created_at).toLocaleString()}
            </span>
          </button>
        ))
      ) : (
        <div className="cloud-note">
          还没有远端执行记录。创建第一个任务后会在这里显示。
        </div>
      )}
    </section>
  );
}
