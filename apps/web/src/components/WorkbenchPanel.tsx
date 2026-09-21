import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, ShieldCheck, Upload, X } from "lucide-react";
import { DiffView } from "./DiffView";

type Policy = { review: boolean; shell: "host" | "docker"; network: boolean; image: string; maxCalls: number; maxTokens: number; maxCost: number; inputPrice: number; outputPrice: number };
type Version = { path: string; data: string | null };
type Operation = { id: string; tool: string; args: Record<string, unknown>; root: string; environment: string; image: string; network: boolean; status: string; before: Version[]; after: Version[]; output?: string; error?: string };
type State = { root: string; currentRoot: string; runtime: string; busy: boolean; policy: Policy; operations: Operation[]; checks: { id: string; result: string }[]; usage: { calls: number; input: number; output: number; estimated: boolean; durationMs: number; cost: number }; remainingSteps: { title: string }[]; lastError?: string };
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "操作失败");
  return data as T;
}
function decode(data: string | null | undefined) {
  if (!data) return "";
  const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  if (raw.includes(0)) return "[二进制文件，请打开原文件核对]";
  return new TextDecoder().decode(raw).slice(0, 12000);
}
const labels: Record<string, string> = { pending: "待批准", applying: "执行结果待核对", applied: "已执行", rejected: "已拒绝／核对", undone: "已撤销", error: "执行失败" };
export function WorkbenchPanel({ sessionId, remote = false, remoteRequireApproval, onOpenRemote, running, onResume, onRefresh, onDraft }: { sessionId: string; remote?: boolean; remoteRequireApproval?: boolean; onOpenRemote?: () => void; running: boolean; onResume: () => void; onRefresh: () => void; onDraft: (text: string) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [docker, setDocker] = useState("");
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; prompt: string; builtin?: boolean }>>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || remote) return;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); trigger.current?.focus(); };
  }, [open, remote]);
  const base = `/api/sessions/${sessionId}`;
  const reload = async () => setState(await request<State>(`${base}/workbench`));
  useEffect(() => {
    if (remote) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await request<State>(`${base}/workbench`); if (active) setState(next); }
      catch (err) { if (active) setError((err as Error).message); }
      if (active) timer = setTimeout(poll, 2500);
    };
    void poll();
    void request<typeof templates>("/api/workbench/templates").then((data) => { if (active) setTemplates(data); }).catch(() => {});
    return () => { active = false; clearTimeout(timer); };
  }, [base, remote]);
  const pending = state?.operations.filter((op) => op.status === "pending") ?? [];
  useEffect(() => { if (pending.length && !remote) setOpen(true); }, [pending.length, remote]);
  const disabled = busy || running || state?.busy;
  async function perform(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); if (!mounted.current) return; await reload(); if (mounted.current) onRefresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || disabled) return;
    const selected = Array.from(files);
    await perform(async () => {
      for (const file of selected) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5MB 上限`);
        const body = new FormData(); body.append("file", file);
        await request(`${base}/upload`, { method: "POST", body });
      }
    });
    if (input.current) input.current.value = "";
  }
  if (remote) return <section className="border-b border-ink-300 bg-panel px-6 py-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><ShieldCheck size={15} className="text-accent" /><span className="font-medium">执行与验收</span><span className="text-ink-500">远端容器 · 控制面调度</span></div>{onOpenRemote && <button className="btn-ghost" onClick={onOpenRemote}>查看远端运行与审批</button>}</div>
    <p className="mt-1 text-ink-500">{remoteRequireApproval ? "写入与命令需经控制面批准后执行。" : "本会话未开启写入前审批。"} 日志、审批决定与成果由控制面保存；下载的成果可另行审阅后导入本机。</p>
  </section>;
  if (!state) return error ? <p className="px-6 py-2 text-xs text-danger">{error}</p> : null;
  return (
    <div className="border-b border-ink-300 bg-panel">
      <button ref={trigger} className="flex w-full items-center gap-2 px-6 py-3 text-left text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ShieldCheck size={15} className="text-accent" /><span className="font-medium">执行与验收</span>
        <span className="min-w-0 flex-1 truncate text-ink-500">{state.runtime !== "pig" ? (state.runtime === "codex" ? "本机 Codex · 使用引擎自身执行权限" : "本机隔离桩 · 本地执行") : pending.length ? `${pending.length} 项变更待批准` : `${state.policy.shell === "docker" ? "Docker" : "宿主机"} · ${state.policy.review ? "先审阅后执行" : "自动执行"}`}</span>
        <ChevronDown size={14} className={open ? "rotate-180" : ""} />
      </button>
      {open && <><button type="button" aria-label="关闭执行与验收遮罩" className="fixed inset-0 z-30 cursor-default bg-overlay" onClick={() => setOpen(false)} /><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="执行与验收" className="fixed inset-y-4 right-4 z-40 w-[min(640px,calc(100vw-32px))] space-y-4 overflow-auto rounded-2xl border border-ink-300 bg-panel p-5 text-xs shadow-lift">
        <div className="flex items-center justify-between"><h2 className="text-base font-semibold">执行与验收</h2><button className="btn-quiet" aria-label="关闭执行与验收" onClick={() => setOpen(false)}><X size={18} /></button></div>
        <div className="rounded-xl bg-ink-100 p-3"><div className="mb-1 font-medium">本任务目标工作区</div><code className="break-all select-all">{state.root}</code><p className="mt-2 text-ink-500">批准仅适用于下列路径和命令。上传资料写入此目录的 uploads 子目录。</p></div>
        {state.currentRoot !== state.root && <p className="text-danger">设置中的工作区已改变，请切回原位置或新建任务。</p>}
        {state.runtime !== "pig" && <p className="text-warning">以下审阅与预算仅用于本机 Pig。当前运行时不通过此面板批准写入；新任务可在顶部选择 Pig。</p>}
        {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={disabled || state.runtime !== "pig" || pending.length > 0 || state.operations.some((op) => (op.status === "applying" || op.status === "error"))} onClick={() => { setOpen(false); onResume(); }}>继续任务</button>
          <button className="btn-ghost" disabled={disabled || state.runtime !== "pig"} onClick={() => setPolicy(policy ? null : { ...state.policy })}>执行设置与预算</button>
          <button className="btn-ghost" disabled={disabled || state.runtime !== "pig"} onClick={() => input.current?.click()}><Upload size={13} />上传资料</button>
          {(state.busy || busy) && <button className="btn-ghost" onClick={() => void request(`${base}/abort`, { method: "POST" }).catch((err) => setError(err.message))}>停止执行</button>}
          {busy && <Loader2 size={16} className="animate-spin" />}
        </div>
        <input ref={input} type="file" multiple className="hidden" aria-label="上传资料" onChange={(e) => void upload(e.target.files)} />
        <div className="rounded-xl border border-dashed border-ink-400 p-3 text-center text-ink-500" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>可拖入文件 · 每个最多 5MB · 同名文件不覆盖 · 二进制文件需解析工具</div>
        {policy && <div className="space-y-3 rounded-xl border border-ink-300 p-3">
          <label className="flex items-center gap-2"><input type="checkbox" checked={policy.review} onChange={(e) => setPolicy({ ...policy, review: e.target.checked })} />写文件及运行命令前审阅</label>
          <label className="block">命令执行环境<select className="field mt-1" value={policy.shell} onChange={(e) => setPolicy({ ...policy, shell: e.target.value as Policy["shell"] })}><option value="host">宿主机（非 OS 沙箱）</option><option value="docker">Docker 容器</option></select></label>
          {policy.shell === "docker" && <><label className="block">Docker 镜像<input className="field mt-1" value={policy.image} onChange={(e) => setPolicy({ ...policy, image: e.target.value })} /></label><label className="flex items-center gap-2"><input type="checkbox" checked={policy.network} onChange={(e) => setPolicy({ ...policy, network: e.target.checked })} />允许容器访问网络</label><p className="text-ink-500">仅挂载当前工作区到 /workspace；只读根文件系统，512MB 内存、1 CPU。镜像需预先下载。</p><button className="btn-ghost" onClick={() => void request<{ available: boolean; version?: string; error?: string }>("/api/workbench/docker").then((r) => setDocker(r.available ? `Docker ${r.version} 可用` : r.error ?? "不可用")).catch((e) => setDocker(e.message))}>检查 Docker</button><span className="ml-2">{docker}</span></>}
          <div className="grid grid-cols-2 gap-3">{([['maxCalls','调用次数上限'],['maxTokens','任务 token 预算'],['maxCost','费用上限（0 不限制）'],['inputPrice','输入价格 / 百万 token'],['outputPrice','输出价格 / 百万 token']] as const).map(([key,label]) => <label key={key}>{label}<input className="field mt-1" type="number" min={0} value={policy[key]} onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })} /></label>)}</div>
          <p className="text-ink-500">价格由你填写，币种保持一致；0 表示未设置价格。预算在下一次请求前检查，估算并非供应商账单。</p>
          <button className="btn-primary" disabled={disabled || pending.length > 0} onClick={() => void perform(async () => { await request(`${base}/workbench`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(policy) }); setPolicy(null); })}>保存执行设置</button>
        </div>}
        <div className="rounded-xl border border-ink-300 p-3"><div className="mb-2 font-medium">用量 · {state.usage.calls}/{state.policy.maxCalls} 次调用</div><p>{state.usage.input.toLocaleString()} 输入 / {state.usage.output.toLocaleString()} 输出 token{state.usage.estimated ? "（含保守估算）" : ""} · {(state.usage.durationMs / 1000).toFixed(1)} 秒</p><p className="mt-1 text-ink-500">{state.policy.inputPrice || state.policy.outputPrice ? `累计估算费用 ${state.usage.cost.toFixed(5)}（按各次调用时的单价）` : "未设置单价，费用暂不估算"}</p></div>
        {state.operations.length > 0 && <div className="space-y-3"><h3 className="font-medium">变更审阅与撤销</h3>{[...state.operations].reverse().map((op) => <details key={op.id} open={op.status === "pending" || op.status === "applying"} className="rounded-xl border border-ink-300 p-3"><summary className="cursor-pointer font-medium">{op.status === "applying" && state.busy ? "执行中" : labels[op.status] ?? op.status} · {op.tool} · {op.after[0]?.path ?? op.environment}</summary><div className="mt-3 space-y-3">
          <p className="break-all">目标：{op.root} · {op.environment === "docker" ? `Docker ${op.image}（网络${op.network ? "开" : "关"}）` : "宿主机"}</p>
          {op.tool === "run_shell" ? <><pre className="overflow-auto rounded bg-ink-100 p-3">{String(op.args.command)}</pre><p className="text-warning">命令可能修改工作区，不能自动撤销。批准前请核对命令。</p></> : op.after.map((v,i) => <div key={v.path}><p className="mb-2 break-all font-mono">{op.root}/{v.path}</p><div className="max-h-56 overflow-auto"><DiffView before={decode(op.before[i]?.data)} after={decode(v.data)} /></div><p className="mt-1 text-ink-500">预览最多 12000 字符；撤销使用完整快照。</p></div>)}
          {op.error && <pre className="whitespace-pre-wrap break-all text-danger">{op.error}</pre>}
          {op.output && <details><summary className="cursor-pointer text-ink-500">执行记录</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{op.output}</pre></details>}
          <p className="text-accent">{labels[state.checks.find((check) => check.id === op.id)?.result ?? ""] ?? state.checks.find((check) => check.id === op.id)?.result}</p>
          <div className="flex gap-2">{(op.status === "pending" ? ["approve", "reject"] : op.status === "applied" && op.before.length ? ["undo"] : op.status === "applying" || op.status === "error" ? ["acknowledge"] : []).map((action) => <button key={action} className={action === "approve" ? "btn-primary" : "btn-ghost"} disabled={disabled} onClick={() => void perform(() => request(`${base}/workbench/${op.id}/${action}`, { method: "POST" }))}>{{ approve: "批准执行", reject: "拒绝", undo: "撤销此修改", acknowledge: "已人工核对，解除阻塞" }[action]}</button>)}</div>
        </div></details>)}</div>}
        <div className="rounded-xl bg-ink-100 p-3"><h3 className="mb-2 flex items-center gap-2 font-medium"><CheckCircle2 size={14} />验收清单</h3><p>待批准：{pending.length} · 已执行：{state.operations.filter((op) => op.status === "applied").length} · 待完成步骤：{state.remainingSteps.length}</p>{state.remainingSteps.map((step,i) => <p key={i} className="mt-1 text-ink-500">□ {step.title}</p>)}{state.lastError && <p className="mt-2 text-danger">{state.lastError}</p>}<p className="mt-2 text-ink-500">文件核验比较磁盘与快照；任务目标是否达成仍需结合内容、测试结果确认。</p></div>
        <details><summary className="cursor-pointer font-medium">任务模板</summary><div className="mt-3 flex flex-wrap gap-2">{templates.map((t) => <div key={t.id} className="flex items-center gap-1"><button className="btn-ghost" onClick={() => onDraft(t.prompt)}>{t.name}</button>{!t.builtin && <button className="btn-quiet" aria-label={`删除模板 ${t.name}`} onClick={() => void perform(async () => { await request(`/api/workbench/templates/${t.id}`, { method: "DELETE" }); setTemplates(await request("/api/workbench/templates")); })}>×</button>}</div>)}</div><p className="mt-2 text-ink-500">选择模板只填写草稿，确认后再发送。</p><input aria-label="模板名称" className="field mt-3" placeholder="模板名称" value={name} onChange={(e) => setName(e.target.value)} /><textarea aria-label="模板指令" className="field mt-2" placeholder="可复用的任务指令" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button className="btn-ghost mt-2" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void perform(async () => { await request("/api/workbench/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, prompt }) }); setTemplates(await request("/api/workbench/templates")); setName(""); setPrompt(""); })}>保存模板</button></details>
      </div></>}
    </div>
  );
}
