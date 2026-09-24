import "./resource-creator.css";
import { useState } from "react";
import { Sparkles } from "lucide-react";

type Draft = { name: string; displayName?: string; description: string; instruction?: string; body?: string };
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败，请重试");
  return value;
}

/** Drafts stay in component memory until the user explicitly creates the resource. */
export function ResourceCreator({ kind, onCreated }: { kind: "expert" | "skill"; onCreated?: (id: string) => void }) {
  const label = kind === "expert" ? "专家" : "技能";
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const patch = (value: Partial<Draft>) => setDraft(prev => prev ? { ...prev, ...value } : prev);
  return <section className="resource-creator" aria-label={`创建${label}`}>
    <button type="button" className="btn-primary" aria-expanded={open} onClick={() => setOpen(!open)}><Sparkles size={14} />一句话创建{label}</button>
    {success && <p role="status" className="settings-note">{success}</p>}
    {open && <div className="resource-creator-body">
      <p className="settings-note">描述用途，使用已配置模型生成草稿。确认创建后保存到本机。</p>
      <label className="block"><span>你希望{label}做什么？</span><textarea className="field mt-1" rows={3} maxLength={4000} value={prompt} disabled={!!busy} onChange={e => setPrompt(e.target.value)} placeholder={kind === "expert" ? "例如：熟悉电商业务的产品专家，帮我把想法整理成可验收的需求" : "例如：分析 CSV 销售数据，找出异常并生成中文报告"} /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={!!busy || prompt.trim().length < 2} onClick={() => {
          setBusy("generate"); setError(""); setSuccess("");
          void post("/api/resource-drafts", { kind, prompt }).then(result => { setDraft(result.draft); setModel(result.model); }).catch(err => setError(String(err.message))).finally(() => setBusy(null));
        }}>{busy === "generate" ? "正在生成草稿…" : draft ? "重新生成草稿" : "生成草稿"}</button>
        {!draft && <button type="button" className="btn-quiet" disabled={!!busy} onClick={() => setDraft({ name: "", description: "", [kind === "expert" ? "instruction" : "body"]: "" })}>手动填写</button>}
      </div>
      {error && <p role="alert" className="resource-error">{error}</p>}
      {draft && <div className="resource-creator-body">
        <p className="settings-note">{model ? `${model} 生成的草稿` : "新建草稿"} · 尚未保存，可直接编辑。</p>
        <label className="block"><span>{kind === "skill" ? "技能标识（小写英文、数字、连字符）" : "专家名称"}</span><input className="field mt-1" value={draft.name} maxLength={kind === "skill" ? 80 : 120} disabled={!!busy} onChange={e => patch({ name: e.target.value })} /></label>
        {kind === "skill" && <label className="block"><span>中文展示名称</span><input className="field mt-1" value={draft.displayName || ""} maxLength={120} disabled={!!busy} onChange={e => patch({ displayName: e.target.value })} placeholder="例如：销售数据分析" /></label>}
        <label className="block"><span>简介</span><input className="field mt-1" value={draft.description} maxLength={2000} disabled={!!busy} onChange={e => patch({ description: e.target.value })} /></label>
        <label className="block"><span>{kind === "expert" ? "专家指令" : "技能步骤"}</span><textarea className="field mt-1" rows={6} maxLength={20000} value={draft.instruction ?? draft.body ?? ""} disabled={!!busy} onChange={e => patch({ [kind === "expert" ? "instruction" : "body"]: e.target.value })} /></label>
        <button type="button" className="btn-primary" disabled={!!busy || !draft.name.trim() || !draft.description.trim() || !(draft.instruction ?? draft.body)?.trim() || (kind === "skill" && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(draft.name))} onClick={() => {
          setBusy("save"); setError("");
          void post(kind === "expert" ? "/api/experts" : "/api/skills", { ...draft, ...(kind === "expert" ? { kind: "custom" } : {}) }).then(created => {
            setSuccess(`${draft.name} 已创建，可在${kind === "expert" ? "专家目录" : "技能列表"}中查看`); setDraft(null); setPrompt(""); setModel(""); setOpen(false); onCreated?.(created.id ?? created.name);
          }).catch(err => setError(String(err.message))).finally(() => setBusy(null));
        }}>{busy === "save" ? "正在保存…" : `确认创建${label}`}</button>
      </div>}
    </div>}
  </section>;
}
