import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FileText, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { cloudRequest } from "./cloud-api";
import { openKnowledgeCitation } from "./KnowledgeCitation";
import "./knowledge.css";

type KnowledgeDocument = { id: string; name: string; size: number; status: "pending" | "processing" | "ready" | "failed"; error?: string; warning?: string; chunks: number; embeddedChunks: number; createdAt: string };
type KnowledgeList = { documents: KnowledgeDocument[]; totals: { documents: number; chunks: number; bytes: number }; retrieval: { mode: "lexical" | "hybrid"; embeddingModel?: string }; canEdit: boolean };
type Hit = { id: string; document: string; heading: string; content: string; score: number; lexicalRank?: number; vectorRank?: number };

const MAX_BYTES = 4 * 1024 * 1024;
const STATUS: Record<KnowledgeDocument["status"], string> = { pending: "排队中", processing: "处理中", ready: "可检索", failed: "失败" };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error || Error("读取文件失败"));
    reader.readAsDataURL(file);
  });

/** Project knowledge base: upload documents, watch ingestion, try retrieval with clickable citations. */
export function KnowledgePanel({ projectId, onCount }: { projectId: string; onCount?: (n: number) => void }) {
  const [data, setData] = useState<KnowledgeList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ hits: Hit[]; mode: string; tookMs: number }>();
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      const next: KnowledgeList = await cloudRequest(`/v1/projects/${projectId}/knowledge`);
      setData(next);
      onCount?.(next.totals.documents);
      setError("");
      return next;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, onCount]);
  useEffect(() => {
    void load();
  }, [load]);
  // Poll while documents are being ingested.
  const pending = data?.documents.some((d) => d.status === "pending" || d.status === "processing");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [pending, load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        errors.push(`${file.name}：超过 4 MiB`);
        continue;
      }
      setBusy(`正在上传 ${file.name}…`);
      try {
        await cloudRequest(`/v1/projects/${projectId}/knowledge`, "POST", { name: file.name, data: await toBase64(file) });
      } catch (e) {
        errors.push(`${file.name}：${(e as Error).message}`);
      }
    }
    setBusy("");
    setError(errors.join("；"));
    if (input.current) input.current.value = "";
    await load();
  }
  async function act(path: string, method: string, label: string) {
    setBusy(label);
    try {
      await cloudRequest(path, method);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy("正在检索…");
    try {
      setResult(await cloudRequest(`/v1/projects/${projectId}/knowledge/search`, "POST", { query: query.trim(), k: 5 }));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!data && !error) return <p role="status">正在读取知识库…</p>;
  return (
    <div className="knowledge-panel">
      <div className="project-intro">
        <h2>项目知识库</h2>
        <p>
          上传文本、Markdown、PDF 或 DOCX，项目对话中的智能体会自动检索并在回答里附上可点击的引用。
          {data && (data.retrieval.mode === "hybrid" ? `检索方式：关键词 + 向量（${data.retrieval.embeddingModel}）。` : "检索方式：中文关键词（BM25）。")}
        </p>
        {data?.canEdit && (
          <>
            <input ref={input} type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,text/*" onChange={(e) => void upload(e.target.files)} />
            <button className="primary-button" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
              <Upload size={15} /> 上传文档
            </button>
          </>
        )}
      </div>
      {(busy || error) && <p className={error ? "knowledge-error" : "knowledge-busy"} role={error ? "alert" : "status"}>{error || busy}</p>}
      <section className="project-section">
        <header>
          <h2>文档</h2>
          {data && <small>{data.totals.documents} 个 · {data.totals.chunks} 个片段 · {size(data.totals.bytes)}</small>}
        </header>
        {data?.documents.length ? (
          data.documents.map((d) => (
            <div className="knowledge-doc" key={d.id}>
              <FileText size={16} />
              <span className="knowledge-doc-name">
                <a href={`/v1/projects/${projectId}/knowledge/${d.id}/download`}>{d.name}</a>
                <small>{size(d.size)}{d.status === "ready" ? ` · ${d.chunks} 个片段` : ""}{d.warning ? ` · ${d.warning}` : ""}{d.error ? ` · ${d.error}` : ""}</small>
              </span>
              <span className={`knowledge-status is-${d.status}`}>{STATUS[d.status]}</span>
              {data.canEdit && (
                <>
                  {(d.status === "failed" || d.status === "ready") && (
                    <button aria-label={`重新处理 ${d.name}`} title="重新处理" disabled={Boolean(busy)} onClick={() => void act(`/v1/projects/${projectId}/knowledge/${d.id}/reindex`, "POST", "正在重新处理…")}>
                      <RefreshCw size={14} />
                    </button>
                  )}
                  <button aria-label={`删除 ${d.name}`} title="删除" disabled={Boolean(busy)} onClick={() => { if (confirm(`从知识库删除「${d.name}」？`)) void act(`/v1/projects/${projectId}/knowledge/${d.id}`, "DELETE", "正在删除…"); }}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))
        ) : (
          <div className="project-empty">
            <BookOpen size={28} />
            <h3>知识库还是空的</h3>
            <p>上传项目资料后，智能体回答相关问题时会先检索并引用原文。</p>
          </div>
        )}
      </section>
      <section className="project-section">
        <header>
          <h2>检索测试</h2>
        </header>
        <form className="knowledge-search" onSubmit={search}>
          <input aria-label="检索知识库" placeholder="输入问题或关键词，例如：签名如何校验" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" disabled={!query.trim() || Boolean(busy)}>
            <Search size={14} /> 检索
          </button>
        </form>
        {result && (
          <ol className="knowledge-hits">
            {result.hits.map((h, i) => (
              <li key={h.id}>
                <button onClick={() => openKnowledgeCitation(h.id)}>
                  <strong>[K{i + 1}] 《{h.document}》{h.heading ? ` › ${h.heading}` : ""}</strong>
                  <span>{h.content.length > 220 ? h.content.slice(0, 220) + "…" : h.content}</span>
                  <small>
                    RRF {h.score.toFixed(4)}{h.lexicalRank ? ` · 关键词第 ${h.lexicalRank}` : ""}{h.vectorRank ? ` · 向量第 ${h.vectorRank}` : ""}
                  </small>
                </button>
              </li>
            ))}
            {!result.hits.length && <li className="project-empty">没有找到相关内容，试试资料中的关键词。</li>}
            <li className="knowledge-took">{result.mode === "hybrid" ? "关键词 + 向量" : "关键词"} · {result.tookMs} ms</li>
          </ol>
        )}
      </section>
    </div>
  );
}
