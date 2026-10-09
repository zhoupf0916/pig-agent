import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cloudRequest } from "./cloud-api";
import "./knowledge.css";

/** Citation links in answers look like [K1](#knowledge:chunk_…); clicking opens the source passage. */
export const KNOWLEDGE_LINK = /^#knowledge:(chunk_[a-f0-9]{32})$/;
const EVENT = "pig-knowledge-citation";
export const openKnowledgeCitation = (chunkId: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: chunkId }));

type ChunkView = {
  chunk: { id: string; document: string; documentId: string; projectId: string; heading: string; content: string };
  context: Array<{ id: string; heading: string; content: string; current: boolean }>;
};

/** Mounted once in the cloud app; shows the cited passage with its neighbours. */
export function KnowledgeCitationHost() {
  const [chunkId, setChunkId] = useState<string>();
  const [view, setView] = useState<ChunkView>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = (e: Event) => setChunkId((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  useEffect(() => {
    if (!chunkId) return;
    let active = true;
    setView(undefined);
    setError("");
    cloudRequest(`/v1/knowledge/chunks/${chunkId}`)
      .then((v) => active && setView(v))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [chunkId]);
  useEffect(() => {
    if (view) current.current?.scrollIntoView({ block: "center" });
    else if (chunkId) dialog.current?.focus();
  }, [view, chunkId]);
  if (!chunkId) return null;
  const close = () => setChunkId(undefined);
  return (
    <div className="cw-modal-backdrop knowledge-citation-backdrop" onClick={close}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="引用来源" className="knowledge-citation" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <header>
          <div>
            <small>引用来源</small>
            <h2>{view ? `《${view.chunk.document}》` : "正在读取…"}</h2>
            {view?.chunk.heading && <p>{view.chunk.heading}</p>}
          </div>
          <button aria-label="关闭" onClick={close}>
            <X size={16} />
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {view && (
          <div className="knowledge-citation-body">
            {view.context.map((c) => (
              <div key={c.id} ref={c.current ? current : undefined} className={c.current ? "is-current" : ""}>
                {c.heading && !c.current && <small>{c.heading}</small>}
                <p>{c.content}</p>
              </div>
            ))}
            <a href={`/v1/projects/${view.chunk.projectId}/knowledge/${view.chunk.documentId}/download`}>下载原文件</a>
          </div>
        )}
      </div>
    </div>
  );
}
