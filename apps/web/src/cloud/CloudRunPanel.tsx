import { ApprovalPreview } from "../components/ApprovalPreview";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../types";
import type {
  CloudApproval,
  CloudArtifactSummary,
} from "@pig-agent/contracts/cloud";
import { ExecutionJournal } from "../components/ExecutionJournal";
import { MarkdownView } from "../components/MarkdownView";
import { redactSecretsForDisplay } from "../lib/remote-retry";
import { cloudRequest as api } from "./cloud-api";
import "./cloud-run-panel.css";

type Run = {
  id: string;
  prompt: string;
  state: string;
  error?: string;
  can_write: boolean;
  created_at: string;
};
type Row = { seq: number; event: AgentEvent };
const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled"].includes(state);
const labels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "执行中",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
};

export function CloudRunPanel({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [run, setRun] = useState<Run | null>(null),
    [rows, setRows] = useState<Row[]>([]);
  const [artifacts, setArtifacts] = useState<CloudArtifactSummary[]>([]),
    [approvals, setApprovals] = useState<CloudApproval[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"result" | "artifacts" | "journal">("result");
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(
      null,
    ),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const base = `/v1/runs/${encodeURIComponent(runId)}`;
  useEffect(() => {
    setNotice("");
  }, [base]);
  useEffect(() => {
    const current = ++generation.current;
    let stopped = false,
      source: EventSource | undefined,
      timer: ReturnType<typeof setTimeout>;
    setRun(null);
    setRows([]);
    setArtifacts([]);
    setApprovals([]);
    setPreview(null);
    setError("");
    setBusy("");
    async function refresh() {
      try {
        const [r, e, a, p] = await Promise.all([
          api(base),
          api(base + "/eventlog"),
          api(base + "/artifacts"),
          api(base + "/approvals"),
        ]);
        if (stopped) return;
        setRun(r.run || r);
        setArtifacts(a.artifacts || []);
        setApprovals(p.approvals || []);
        setError("");
        const events: Row[] = (e.events || []).map((row: Row) => ({
          ...row,
          seq: Number(row.seq),
        }));
        setRows((old) =>
          [...new Map([...old, ...events].map((x) => [x.seq, x])).values()]
            .sort((a, b) => a.seq - b.seq)
            .slice(-1000),
        );
        if (!terminal((r.run || r).state)) {
          if (!source) {
            const cursor = events.at(-1)?.seq || 0;
            source = new EventSource(base + "/events?after=" + cursor);
            source.onmessage = (message) => {
              if (stopped) return;
              const seq = Number(message.lastEventId);
              if (!Number.isFinite(seq) || seq <= 0) return;
              try {
                const event = JSON.parse(message.data) as AgentEvent;
                setRows((old) =>
                  old.some((x) => x.seq === seq)
                    ? old
                    : [...old, { seq, event }].slice(-1000),
                );
              } catch {
                /* Polling reconciles malformed or disconnected stream snapshots. */
              }
            };
          }
          timer = setTimeout(refresh, 1800);
        } else source?.close();
      } catch (e) {
        if (stopped) return;
        source?.close();
        source = undefined;
        setRun(null);
        setRows([]);
        setArtifacts([]);
        setApprovals([]);
        setPreview(null);
        setError(e instanceof Error ? e.message : "执行详情加载失败");
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      if (generation.current === current) generation.current++;
    };
  }, [base, revision]);
  const events = useMemo(() => rows.map((r) => r.event), [rows]);
  const result = useMemo(() => {
    let complete = "",
      streaming = "";
    for (const event of events) {
      if (event.type === "token") streaming += event.text;
      if (
        event.type === "message" &&
        event.message.role === "assistant" &&
        event.message.content
      ) {
        complete = event.message.content;
        streaming = "";
      }
      if (event.type === "done") {
        const last = event.session?.messages
          ?.filter((m) => m.role === "assistant" && m.content)
          .at(-1);
        if (last) {
          complete = last.content;
          streaming = "";
        }
      }
    }
    return streaming || complete;
  }, [events]);
  async function act(path: string, body: unknown, key: string) {
    const current = generation.current;
    setBusy(key);
    setNotice("");
    try {
      await api(base + path, "POST", body);
      if (current !== generation.current) return;
      setNotice(key === "abort" ? "停止请求已提交" : "审批决定已保存");
      setRevision((x) => x + 1);
    } catch (e) {
      if (current === generation.current)
        setNotice(e instanceof Error ? e.message : "操作失败");
    } finally {
      if (current === generation.current) setBusy("");
    }
  }
  async function inspect(artifact: CloudArtifactSummary) {
    const current = generation.current;
    setNotice("");
    if (artifact.size > 512_000) {
      setNotice("文件较大，请下载后查看（在线预览上限 500 KB）。");
      return;
    }
    if (
      /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp[34]|mov|woff2?|ttf|xlsx?|docx?|pptx?)$/i.test(
        artifact.path,
      )
    ) {
      setNotice("此格式请下载后查看。");
      return;
    }
    setBusy(artifact.id);
    try {
      const response = await fetch(
        base + "/artifacts/" + encodeURIComponent(artifact.id),
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(`成果读取失败 (${response.status})`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 512_000)
        throw new Error("文件超出在线预览上限，请下载查看。");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取成果内容");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512_000) {
          await reader.cancel();
          throw new Error("文件超出在线预览上限，请下载查看。");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (bytes.includes(0))
        throw new Error("该成果为二进制文件，请下载查看。");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (current === generation.current)
        setPreview({
          path: artifact.path,
          text: redactSecretsForDisplay(text),
        });
    } catch (e) {
      if (current === generation.current)
        setNotice(e instanceof Error ? e.message : "成果读取失败");
    } finally {
      if (current === generation.current) setBusy("");
    }
  }
  const pending = approvals.filter((a) => a.state === "pending").slice(0, 1);
  return (
    <section className="cloud-run-panel">
      <header>
        <button onClick={onClose}>← 返回</button>
        <span>远端执行</span>
      </header>
      {error ? (
        <div role="alert" className="cloud-run-empty">
          <h2>暂时无法读取执行</h2>
          <p>{error}</p>
          <button onClick={() => setRevision((x) => x + 1)}>重新加载</button>
        </div>
      ) : !run ? (
        <div role="status" className="cloud-run-empty">
          正在加载执行详情…
        </div>
      ) : (
        <>
          <div className="cloud-run-heading">
            <div>
              <span className="cloud-run-state">
                {pending.length ? "等待审批" : labels[run.state] || run.state}
              </span>
              <h1>{run.prompt || "远端任务"}</h1>
              <p>
                {new Date(run.created_at).toLocaleString()} ·{" "}
                {run.can_write ? "可操作" : "只读访问"}
              </p>
            </div>
            {run.can_write && !terminal(run.state) && (
              <button
                disabled={!!busy || run.state === "cancelling"}
                onClick={() => void act("/abort", {}, "abort")}
              >
                停止执行
              </button>
            )}
          </div>
          {notice && (
            <p role="status" className="cloud-run-notice">
              {notice}
            </p>
          )}
          {run.error && (
            <p role="alert" className="cloud-run-error">
              {redactSecretsForDisplay(run.error)}
            </p>
          )}
          {pending.map((approval) => (
            <section className="cloud-run-approval" key={approval.id}>
              <h2>需要你的批准</h2>
              <p>
                {approval.tool === "http_fetch"
                  ? "仅批准本次 GET 请求；不开放沙箱网络。"
                  : `待执行操作：${approval.tool}`}
              </p>
              <ApprovalPreview tool={approval.tool} args={approval.args}/>
              {run.can_write ? (
                <div>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act(
                        `/approvals/${encodeURIComponent(approval.id)}/decision`,
                        { decision: "approve" },
                        approval.id,
                      )
                    }
                  >
                    允许本次操作
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act(
                        `/approvals/${encodeURIComponent(approval.id)}/decision`,
                        { decision: "reject" },
                        approval.id,
                      )
                    }
                  >
                    拒绝
                  </button>
                </div>
              ) : (
                <p>请等待有操作权限的成员审批。</p>
              )}
            </section>
          ))}
          <nav aria-label="执行详情">
            <button
              aria-pressed={tab === "result"}
              onClick={() => setTab("result")}
            >
              执行结果
            </button>
            <button
              aria-pressed={tab === "artifacts"}
              onClick={() => setTab("artifacts")}
            >
              成果{artifacts.length ? ` · ${artifacts.length}` : ""}
            </button>
            <button
              aria-pressed={tab === "journal"}
              onClick={() => setTab("journal")}
            >
              执行过程
            </button>
          </nav>
          <div className="cloud-run-body">
            {tab === "result" ? (
              result ? (
                <MarkdownView text={result} />
              ) : (
                <div className="cloud-run-empty">
                  {terminal(run.state)
                    ? "本次执行没有生成文字回复，可查看成果或执行过程。"
                    : "任务进行中，回复会自动显示在这里。"}
                </div>
              )
            ) : tab === "journal" ? (
              <>
                <ExecutionJournal events={events} />
                {rows.length >= 200 && (
                  <p className="cloud-run-muted">此页保留最近的执行事件。</p>
                )}
              </>
            ) : (
              <>
                {!artifacts.length && (
                  <div className="cloud-run-empty">本次执行暂无成果文件。</div>
                )}
                {artifacts.map((a) => (
                  <div className="cloud-run-artifact" key={a.id}>
                    <div>
                      <strong>{a.path}</strong>
                      <small>{a.size.toLocaleString()} 字节</small>
                    </div>
                    <button disabled={!!busy} onClick={() => void inspect(a)}>
                      预览
                    </button>
                    <a
                      href={base + "/artifacts/" + encodeURIComponent(a.id)}
                      download
                    >
                      下载
                    </a>
                  </div>
                ))}
                {preview && (
                  <section className="cloud-run-preview">
                    <header>
                      <strong>{preview.path}</strong>
                      <button onClick={() => setPreview(null)}>关闭预览</button>
                    </header>
                    <pre>{preview.text}</pre>
                  </section>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
