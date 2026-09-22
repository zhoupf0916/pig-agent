import { useRef, useState, useEffect } from "react";
import { Paperclip, X, RotateCcw, FileText } from "lucide-react";
import "./message-attachments.css";
export type Attachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: string;
  warning?: string;
  workspacePath: string;
};
type Item = {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "ready" | "error";
  error?: string;
  attachment?: Attachment;
  file?: File;
};
type Request = (path: string, method?: string, body?: unknown) => Promise<any>;
function stored(scope: string): Item[] {
  try {
    return JSON.parse(
      sessionStorage.getItem("pig-attachments:" + scope) || "[]",
    );
  } catch {
    return [];
  }
}
export function useMessageAttachments(scope: string, request: Request) {
  const [state, setState] = useState<{ scope: string; items: Item[] }>(() => ({
    scope,
    items: stored(scope),
  }));
  const removed = useRef(new Set<string>());
  const current = useRef(scope);
  current.current = scope;
  const items = state.scope === scope ? state.items : stored(scope);
  useEffect(() => {
    if (state.scope !== scope) setState({ scope, items: stored(scope) });
  }, [scope]);
  const update = (scopeKey: string, fn: (items: Item[]) => Item[]) =>
    setState((old) => {
      const next = fn(old.scope === scopeKey ? old.items : stored(scopeKey));
      try {
        sessionStorage.setItem(
          "pig-attachments:" + scopeKey,
          JSON.stringify(
            next.map(({ file, ...i }) =>
              i.state === "uploading"
                ? {
                    ...i,
                    state: "error",
                    error: "上传中断，请移除后重新选择文件",
                  }
                : i,
            ),
          ),
        );
      } catch {}
      return current.current === scopeKey
        ? { scope: scopeKey, items: next }
        : old;
    });
  async function upload(item: Item, scopeKey: string) {
    if (!item.file) return;
    update(scopeKey, (items) =>
      items.map((i) =>
        i.key === item.key ? { ...i, state: "uploading", error: undefined } : i,
      ),
    );
    try {
      if (item.size > 4 * 1024 * 1024) throw Error("单个文件不能超过 4 MB");
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(Error("文件读取失败"));
        r.readAsDataURL(item.file!);
      });
      const result = await request("/v1/attachments", "POST", {
        name: item.name,
        contentType: item.file.type || "application/octet-stream",
        data,
      });
      if (removed.current.has(item.key)) {
        void request(`/v1/attachments/${result.attachment.id}`, "DELETE").catch(
          () => {},
        );
        return;
      }
      update(scopeKey, (items) =>
        items.map((i) =>
          i.key === item.key
            ? { ...i, state: "ready", attachment: result.attachment }
            : i,
        ),
      );
    } catch (e) {
      update(scopeKey, (items) =>
        items.map((i) =>
          i.key === item.key
            ? { ...i, state: "error", error: String((e as Error).message) }
            : i,
        ),
      );
    }
  }
  function add(files: FileList | File[]) {
    const scopeKey = scope;
    const selected=Array.from(files);
    const available=Math.max(0,10-items.length);
    let bytes=items.reduce((n,item)=>n+item.size,0);
    const incoming:Item[]=selected.slice(0,available).map(file=>{
      bytes+=file.size;
      const error=file.size>4*1024*1024?"单个文件不能超过 4 MB":bytes>8*1024*1024?"附件总量不能超过 8 MB":undefined;
      return {key:crypto.randomUUID(),name:file.name,size:file.size,state:error?"error":"uploading",error,file};
    });
    if(selected.length>available)incoming.push({key:crypto.randomUUID(),name:"部分文件未添加",size:0,state:"error",error:"每条消息最多 10 个附件；请移除此提示后继续。"});
    update(scopeKey, (old) => [...old, ...incoming]);
    void (async()=>{for(const item of incoming)if(item.state==="uploading")await upload(item,scopeKey)})();
  }
  return {
    items,
    add,
    retry: (item: Item) => void upload(item, scope),
    remove: (key: string) => {
      removed.current.add(key);
      const item = items.find((i) => i.key === key);
      if (item?.attachment)
        void request(`/v1/attachments/${item.attachment.id}`, "DELETE").catch(
          () => {},
        );
      update(scope, (items) => items.filter((i) => i.key !== key));
    },
    clear: () => update(scope, () => []),
    ids: items.flatMap((i) => (i.attachment ? [i.attachment.id] : [])),
    blocked:
      items.some((i) => i.state !== "ready") ||
      items.length > 10 ||
      items.reduce((n, i) => n + i.size, 0) > 8 * 1024 * 1024,
  };
}
export function MessageAttachments({
  value,
  disabled,
}: {
  value: ReturnType<typeof useMessageAttachments>;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="message-attachments">
      {!!value.items.length && (
        <div className="attachment-list" aria-live="polite">
          {value.items.map((item) => (
            <div className={`attachment-chip ${item.state}`} key={item.key}>
              <FileText size={16} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.state === "uploading"
                    ? "正在上传…"
                    : item.state === "error"
                      ? item.error
                      : `${Math.ceil(item.size / 1024)} KB · ${item.attachment?.warning || "已就绪"}`}
                </small>
              </span>
              {item.state === "error" && item.file && (
                <button
                  type="button"
                  aria-label={`重试上传 ${item.name}`}
                  onClick={() => value.retry(item)}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                type="button"
                aria-label={`移除 ${item.name}`}
                onClick={() => value.remove(item.key)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) value.add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        className="attach-trigger"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={15} />
        添加文件
      </button>
      <span className="attachment-hint">
        可拖入文件或粘贴截图 · 单文件 4 MB
      </span>
      {value.items.length > 10 && (
        <p role="alert">每条消息最多 10 个附件，请移除多余文件。</p>
      )}
      {value.items.reduce((n, i) => n + i.size, 0) > 8 * 1024 * 1024 && (
        <p role="alert">每条消息附件总量不能超过 8 MB。</p>
      )}
    </div>
  );
}
