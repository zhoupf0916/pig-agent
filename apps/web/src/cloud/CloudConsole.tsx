import { useEffect, useRef, useState } from "react";
import "./cloud.css";
import type {
  CloudRunSummary as Run,
  CloudArtifactSummary as Artifact,
} from "@pig-agent/contracts/cloud";
const labels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备容器",
  running: "执行中",
  cancelling: "正在停止",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
};
export function CloudConsole() {
  const [modelMode, setModelMode] = useState("unknown");
  useEffect(() => {
    document.title = "Pig Cloud · 云工作台";
    void fetch("/health")
      .then((r) => r.json())
      .then((data) => setModelMode(data.modelMode))
      .catch(() => {});
  }, []);
  const [token, setToken] = useState(
    () => sessionStorage.getItem("pig.cloud.token") || "",
  );
  const [draftToken, setDraftToken] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>(
    [],
  );
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  async function api(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    async function refresh() {
      try {
        const data = await api("/v1/runs");
        if (!stopped) setRuns(data.runs);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [token]);
  const state = runs.find((r) => r.id === selected)?.state;
  useEffect(() => {
    if (!token || !selected) return;
    const controller = new AbortController();
    setEvents([]);
    setArtifacts([]);
    let after = 0;
    let stopped = false;
    async function subscribe() {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(
            `/v1/runs/${selected}/events?after=${after}`,
            { headers, signal: controller.signal },
          );
          if (!response.ok) throw Error("事件流连接失败");
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            buffer += decoder.decode(part.value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const id = frame.match(/^id: (\d+)/m);
              if (!id) continue;
              after = Number(id[1]);
              const line = frame.match(/^data: (.*)$/m);
              if (line) {
                const event = JSON.parse(line[1]!);
                if (event.type === "token") continue;
                const text =
                  event.type === "message"
                    ? event.message?.content
                    : event.type === "tool_start"
                      ? `执行工具：${event.name}`
                      : event.type === "tool_end"
                        ? `${event.ok ? "✓" : "✕"} ${event.name}：${event.output}`
                        : event.type === "error"
                          ? event.message
                          : "";
                if (text && !stopped)
                  setEvents((prev) => [...prev.slice(-99), text]);
              }
            }
          }
          if (!stopped) {
            const result = await api(`/v1/runs/${selected}/artifacts`);
            setArtifacts(result.artifacts);
          }
          break;
        } catch (e) {
          if (controller.signal.aborted) break;
          if (!stopped) setError("事件连接中断，正在重连…");
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    void subscribe();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [selected, token]);
  async function submit() {
    if (lock.current || !prompt.trim()) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      const created = await api("/v1/runs", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ prompt, files }),
      });
      setSelected(created.id);
      setPrompt("");
      setFiles([]);
      setRuns((await api("/v1/runs")).runs);
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  async function download(file: Artifact) {
    try {
      const r = await fetch(`/v1/runs/${selected}/artifacts/${file.id}`, {
        headers,
      });
      if (!r.ok) throw Error("下载失败");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = file.path.split("/").pop() || "artifact";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="cloud-shell">
      <header>
        <a href="/cloud" className="cloud-brand">
          P<span>Pig Cloud</span>
        </a>
        <span className="cloud-badge">本地 Docker · 预览版</span>
        <nav>
          <a href="/admin/">管理后台 ↗</a>
          {token && (
            <button
              onClick={() => {
                sessionStorage.removeItem("pig.cloud.token");
                setToken("");
                setSelected("");
                setRuns([]);
              }}
            >
              退出
            </button>
          )}
        </nav>
      </header>
      {!token ? (
        <section className="cloud-login">
          <span className="cloud-eyebrow">YOUR CLOUD WORKSPACE</span>
          <h1>让任务在云端继续。</h1>
          <p>
            连接本机 Docker
            平台。当前使用本地访问令牌，账号登录将在后续阶段接入。
          </p>
          <label>
            访问令牌
            <input
              type="password"
              value={draftToken}
              onChange={(e) => setDraftToken(e.target.value)}
              placeholder="从 data/cloud-local/access.txt 获取"
            />
          </label>
          <button
            className="cloud-primary"
            disabled={!draftToken.trim()}
            onClick={async () => {
              try {
                const r = await fetch("/v1/me", {
                  headers: { Authorization: `Bearer ${draftToken.trim()}` },
                });
                if (!r.ok) throw Error("访问令牌无效");
                sessionStorage.setItem("pig.cloud.token", draftToken.trim());
                setToken(draftToken.trim());
                setDraftToken("");
                setError("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            进入工作台
          </button>
        </section>
      ) : (
        <main>
          <aside>
            <h2>
              云端任务 <small>{runs.length}</small>
            </h2>
            {!runs.length && <p>提交第一项任务，执行记录会显示在这里。</p>}
            {runs.map((run) => (
              <button
                className={
                  selected === run.id ? "cloud-run selected" : "cloud-run"
                }
                key={run.id}
                onClick={() => setSelected(run.id)}
              >
                <strong>{run.prompt.slice(0, 60)}</strong>
                <span>
                  {labels[run.state] || run.state} ·{" "}
                  {new Date(run.created_at).toLocaleTimeString()}
                </span>
              </button>
            ))}
          </aside>
          <article>
            <div className="cloud-heading">
              <div>
                <span className="cloud-eyebrow">CLOUD EXECUTION</span>
                <h1>{selected ? "任务执行记录" : "创建云端任务"}</h1>
              </div>
              {selected && (
                <span className="cloud-badge">{labels[state || "queued"]}</span>
              )}
            </div>
            <p className="cloud-note">
              {modelMode === "mock"
                ? "当前使用模拟模型：会真实启动容器、写入并核验 cloud-proof.txt。"
                : modelMode === "unknown"
                  ? "正在检查模型渠道…"
                  : "当前使用平台配置的真实模型渠道。"}
              文件仅影响任务副本；此阶段不提供逐项写入审批。
            </p>
            {selected && (
              <section className="cloud-timeline">
                {!events.length && <p>等待执行事件…</p>}
                {events.map((text, i) => (
                  <pre key={i}>{text}</pre>
                ))}
                {runs.find((r) => r.id === selected)?.error && (
                  <p role="alert">
                    {runs.find((r) => r.id === selected)?.error}
                  </p>
                )}
                {["queued", "preparing", "running"].includes(state || "") && (
                  <button
                    onClick={() =>
                      void api(`/v1/runs/${selected}/abort`, {
                        method: "POST",
                      }).catch((e) => setError(String(e)))
                    }
                  >
                    停止任务
                  </button>
                )}
                {artifacts.map((file) => (
                  <button key={file.id} onClick={() => void download(file)}>
                    下载 {file.path} · {file.size} 字符
                  </button>
                ))}
              </section>
            )}
            <section className="cloud-compose">
              <label htmlFor="cloud-prompt">下一项任务</label>
              <textarea
                id="cloud-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：读取上传的说明，生成一份报告…"
              />
              <div>
                <label className="cloud-upload">
                  附加文本文件
                  <input
                    type="file"
                    multiple
                    onChange={async (e) => {
                      try {
                        const selectedFiles = Array.from(e.target.files || []);
                        if (
                          selectedFiles.length > 20 ||
                          selectedFiles.some((f) => f.size > 200000)
                        )
                          throw Error("最多 20 个文件，每个不超过 200 KB");
                        setFiles(
                          await Promise.all(
                            selectedFiles.map(async (f) => ({
                              path: f.name,
                              content: await f.text(),
                            })),
                          ),
                        );
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  />
                </label>
                <span>{files.length} 个文件</span>
                <button
                  className="cloud-primary"
                  disabled={sending || !prompt.trim()}
                  onClick={() => void submit()}
                >
                  {sending ? "提交中…" : "提交到容器 →"}
                </button>
              </div>
            </section>
          </article>
        </main>
      )}
      {error && (
        <div className="cloud-error" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
    </div>
  );
}
