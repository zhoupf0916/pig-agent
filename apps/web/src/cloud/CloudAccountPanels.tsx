import { useEffect, useState, useRef } from "react";
import { cloudRequest as api } from "./cloud-api";
export function CloudSettingsPanel() {
  const [value, setValue] = useState<{
      networkPolicy: "ask" | "blocked";
      requireApproval: boolean;
      memoryEnabled: boolean;
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
      <h2>设置</h2>
      <p className="muted">
        账号设置保存后作用于新任务，进行中的任务保持原有配置。
      </p>
      {error && <p role="alert">{error}</p>}
      {!value ? (
        error ? (
          <button onClick={() => setReload((v) => v + 1)}>重新加载设置</button>
        ) : (
          <p role="status">正在读取设置…</p>
        )
      ) : (
        <form
          className="cloud-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            setSaved("");
            try {
              setValue(
                await api("/v1/settings", "PUT", {
                  networkPolicy: value.networkPolicy,
                  requireApproval: value.requireApproval,
                  memoryEnabled: value.memoryEnabled,
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
            <small>仅授权单次 HTTPS GET，不开放命令联网或安装依赖。</small>
          </label>
          <label>
            默认操作审批
            <select disabled={busy} value={value.requireApproval ? "review" : "auto"} onChange={e=>setValue({...value,requireApproval:e.target.value==="review"})}>
              <option value="review">写入与命令需审批</option>
              <option value="auto">沙箱内自动执行</option>
            </select>
            <small>审批档逐次确认文件变更和所有命令；读取、搜索无需审批。自动档允许上述操作在沙箱内直接执行，网络规则保持独立。</small>
            <small>适用于新任务与新建自动化；已有任务和计划保留已保存的策略。</small>
          </label>
          <label className="cloud-check">
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
          <p className="muted">私人记忆不会注入项目协同任务。</p>
          <div className="cloud-note">
            执行环境：远端 Runner · 原生沙箱
            <br />
            模型与执行资源由控制面管理员配置。
          </div>
          <button className="primary-button" disabled={busy}>
            {busy ? "保存中…" : "保存设置"}
          </button>
          {saved && <p role="status">{saved}</p>}
        </form>
      )}
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
      <h2>记忆</h2>
      <p className="muted">
        保存长期偏好和背景，帮助个人任务理解你。不会带入团队共享任务。
      </p>
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
  const [q, setQ] = useState(""),
    [results, setResults] = useState<
      Array<{ conversationId: string; title: string; snippet: string }>
    >([]),
    [searched, setSearched] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="cloud-page">
      <h2>搜索</h2>
      <p className="muted">搜索你有权访问的任务和消息。</p>
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
      <h2>远端记录</h2>
      <p className="muted">查看远端执行记录，进入任务检查审批、日志和成果。</p>
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
