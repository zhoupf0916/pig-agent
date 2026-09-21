import { useEffect, useRef, useState } from "react";
import { useDialog } from "../lib/use-dialog";
import { describeExecutionSurface } from "../lib/runtime-surface";
import { loadPersistedTheme, persistTheme, browserThemeStorage, browserThemeRoot, type Theme } from "../lib/theme";
import type { Settings, SkillMeta } from "../types";

const emptyForm: Settings = {
  llmBaseUrl: "", llmApiKey: "", llmModel: "", workspaceRoot: "", runtime: "pig",
  codexBinaryPath: "", codexModel: "deepseek-flash", codexApiKey: "",
  codexBaseUrl: "https://api.deepseek.com/", codexNetworkAccess: false,
  cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub", cloudRepoUrl: "", cloudRepoRef: "",
};
const editableKeys = Object.keys(emptyForm) as (keyof Settings)[];
const draftKey = (value: Settings) => JSON.stringify(editableKeys.map(key => value[key] ?? emptyForm[key]));
const sections = [
  { id: "model", title: "模型连接", hint: "提供商、模型与密钥" },
  { id: "execution", title: "执行默认值", hint: "新任务的执行方式" },
  { id: "workspace", title: "工作区", hint: "文件范围与远端仓库" },
  { id: "remote", title: "远端连接", hint: "加入控制面与检查连接" },
  { id: "appearance", title: "外观", hint: "这台设备的显示偏好" },
  { id: "advanced", title: "高级选项", hint: "运行诊断与本地技能" },
] as const;
type Section = typeof sections[number]["id"];

export function SettingsModal({ open, settings, skills, onClose, onSave, theme, onTheme }: {
  open: boolean; settings: Settings | null; skills: SkillMeta[];
  onClose: () => void; onSave: (patch: Partial<Settings>) => Promise<void>;
  theme?: Theme; onTheme?: (theme: Theme) => void;
}) {
  const [form, setForm] = useState<Settings>(emptyForm);
  const [section, setSection] = useState<Section>("model");
  const [modelTab, setModelTab] = useState<"pig" | "codex">("pig");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [invite, setInvite] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [appearance, setAppearance] = useState<Theme>(() => theme ?? loadPersistedTheme());
  const [baseline, setBaseline] = useState(draftKey(emptyForm));
  const primed = useRef(false);
  const dirty = draftKey(form) !== baseline || Boolean(invite.trim());
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const mountedOpen = useRef(open); mountedOpen.current = open;
  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscardOpen(true); else onClose();
  };
  const dialog = useDialog(open, requestClose);
  const discardDialog = useDialog(discardOpen, () => setDiscardOpen(false));
  useEffect(() => {
    const node = discardDialog.current;
    if (!discardOpen || !node) return;
    const contain = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDiscardOpen(false); }
    };
    node.addEventListener("keydown", contain, true);
    return () => node.removeEventListener("keydown", contain, true);
  }, [discardOpen, discardDialog]);
  const patch = (next: Partial<Settings>) => { setForm(value => ({ ...value, ...next })); setFeedback(""); setError(null); };

  useEffect(() => {
    if (!open) { primed.current = false; return; }
    if (!settings) return;
    // A background status poll must never erase an unsaved non-secret draft either.
    if (!primed.current || (!dirtyRef.current && !saving)) {
      const next = { ...emptyForm, ...settings };
      setForm(next); setBaseline(draftKey(next));
    }
    if (!primed.current) {
      primed.current = true; setSection("model"); setModelTab(settings.runtime === "codex" ? "codex" : "pig");
      setError(null); setFeedback(""); setInvite(""); setDiscardOpen(false);
    }
  }, [open, settings, saving]);
  useEffect(() => { if (theme) setAppearance(theme); }, [theme]);

  const validate = () => {
    for (const [key, label, group] of [
      ["llmBaseUrl", "模型接口地址", "model"], ["codexBaseUrl", "Codex 接口地址", "model"], ["cloudBaseUrl", "控制面地址", "remote"],
    ] as const) {
      const value = form[key]?.trim();
      if (!value) continue;
      try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error();
      } catch { setSection(group); setError(`${label}需要完整的 http:// 或 https:// 地址，且不能在地址中包含密钥。`); return false; }
    }
    if (form.runtime === "cloud" && form.cloudMode === "remote" && !form.cloudBaseUrl.trim() && !settings?.cloudStatus?.effectiveBaseUrl) {
      setSection("remote"); setError("请填写远端控制面地址，或先选择本地执行。"); return false;
    }
    return true;
  };
  const markSaved = (saved: Settings) => {
    const next = { ...saved, codexApiKey: "", ...(window.pigDesktop ? { llmApiKey: "", cloudToken: "" } : {}) };
    setForm(next); setBaseline(draftKey(next)); setInvite("");
  };
  const save = async () => {
    if (!validate()) return;
    setSaving(true); setError(null); setFeedback("");
    try { await onSave(form); markSaved(form); setFeedback("已保存。新任务使用更新后的默认值；会话中的显式配置优先。"); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试。草稿已保留。"); }
    finally { setSaving(false); }
  };
  const test = async (remote: boolean) => {
    if (!validate()) return;
    setSaving(true); setError(null); setFeedback("");
    try {
      await onSave(form); markSaved(form);
      const response = await fetch(remote ? "/api/remote/v1/runs" : "/api/settings/test-connection", { method: remote ? "GET" : "POST", signal: AbortSignal.timeout(40000) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "连接失败");
      setFeedback(remote ? "已保存，控制面连接正常，访问权限已验证。" : form.runtime === "codex" ? "已保存，Codex 已启动并收到模型回复。" : "已保存，模型已返回有效回复。");
    } catch (e) { setError(`${e instanceof Error ? e.message : "连接失败或超时"}。已保存的设置会保留，可修改后重新测试。`); }
    finally { setSaving(false); }
  };
  const reuseKey = async () => {
    if (!validate()) return;
    setSaving(true); setError(null); setFeedback("");
    try {
      await onSave(form); markSaved(form);
      const response = await fetch("/api/settings/codex/use-pig-key", { method: "POST" });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "无法复用密钥");
      const next = { ...form, codexApiKey: "", codexApiKeyConfigured: true };
      markSaved(next); setFeedback("已将同一提供商的 Pig 密钥保存为 Codex 专用密钥。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const acceptInvite = async () => {
    if (!validate()) return;
    setSaving(true); setError(null); setFeedback("");
    try {
      const response = await fetch("/api/remote/accept-invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: form.cloudBaseUrl, invite: invite.trim() }), signal: AbortSignal.timeout(20000) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || "加入失败");
      const next = { ...form, cloudMode: "remote" as const, cloudToken: result.token };
      // Keep the newly issued credential in the draft if persistence fails; do not redeem the invite twice.
      setForm(next); setInvite(""); await onSave(next); markSaved(next);
      setFeedback(`已加入 ${result.account.name}。访问会话有效期 30 天。`);
    } catch (e) { if (mountedOpen.current) setError(e instanceof Error ? e.message : "加入失败"); }
    finally { setSaving(false); }
  };
  const surface = describeExecutionSurface({ ...form, effectiveBaseUrl: form.cloudBaseUrl.trim() || settings?.cloudStatus?.effectiveBaseUrl });
  if (!open) return null;
  const currentSection = sections.find(item => item.id === section)!;
  const changeTheme = (next: Theme) => { setAppearance(next); if (onTheme) onTheme(next); else persistTheme(next, { storage: browserThemeStorage(), root: browserThemeRoot() }); };

  return <div className="settings-overlay fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="settings-dialog">
      <header className="settings-header">
        <div><h2 id="settings-title">设置</h2><p>管理这台设备的连接与执行偏好</p></div>
        <button type="button" onClick={requestClose} disabled={saving} className="btn-quiet" aria-label="关闭">关闭</button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分组">
          {sections.map(item => <button type="button" key={item.id} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
            <span>{item.title}</span><small>{item.hint}</small>
          </button>)}
        </nav>
        <div className="settings-content" key={section}>
          <div className="settings-section-heading"><h3>{currentSection.title}</h3><p>{currentSection.hint}</p></div>
          <fieldset disabled={saving} className="settings-fields">
          {section === "model" && <>
            <div className="settings-scope">本机模型由这里配置；远端任务使用控制面管理员分配的模型。</div>
            <div className="settings-segment" role="group" aria-label="模型引擎">
              <button type="button" aria-pressed={modelTab === "pig"} onClick={() => setModelTab("pig")}>Pig 模型</button>
              <button type="button" aria-pressed={modelTab === "codex"} onClick={() => setModelTab("codex")}>Codex 模型</button>
            </div>
            {modelTab === "pig" ? <>
              <Field label="模型接口地址" hint="支持 DeepSeek、OpenAI 兼容接口和本机 Ollama。"><input className="field" value={form.llmBaseUrl} onChange={e => patch({ llmBaseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></Field>
              <Field label="API Key" hint={settings?.llmApiKeyConfigured ? "已保存密钥，留空保持不变。" : "Ollama 等本机服务可留空。"}><input className="field" type="password" autoComplete="off" value={form.llmApiKey} onChange={e => patch({ llmApiKey: e.target.value })} placeholder={settings?.llmApiKeyConfigured ? "已保存；留空保持不变" : "填写提供商密钥"} /></Field>
              <Field label="Pig 模型"><input className="field" value={form.llmModel} onChange={e => patch({ llmModel: e.target.value })} placeholder="deepseek-chat" /></Field>
            </> : <>
              <Field label="Codex Responses 接口地址"><input className="field" value={form.codexBaseUrl ?? ""} onChange={e => patch({ codexBaseUrl: e.target.value })} placeholder="https://api.deepseek.com/" /></Field>
              <Field label="Codex 专用 API Key" hint="独立于 Pig 密钥和 Codex App 登录账号；留空保留已保存值。"><input className="field" type="password" autoComplete="off" value={form.codexApiKey ?? ""} onChange={e => patch({ codexApiKey: e.target.value })} placeholder={settings?.codexApiKeyConfigured ? "已保存；留空保持不变" : "填写 Responses 提供商密钥"} /></Field>
              <button type="button" className="btn-quiet" onClick={() => void reuseKey()}>同一提供商：使用已保存的 Pig 密钥</button>
              <Field label="Codex 模型"><input className="field" value={form.codexModel} onChange={e => patch({ codexModel: e.target.value })} placeholder="deepseek-flash" /></Field>
            </>}
            {form.runtime !== "cloud" ? <div className="settings-action-row"><button type="button" className="btn-secondary" onClick={() => void test(false)}>保存并测试当前运行时</button><p>测试当前默认引擎（{form.runtime === "codex" ? "Codex" : "Pig"}），会发起一次简短模型请求。</p></div> : <p className="settings-note">当前默认远端执行，请在「远端连接」检查控制面。本机模型可保存供本地任务使用。</p>}
          </>}
          {section === "execution" && <>
            <div className="settings-scope">仅作为新会话默认值。已有会话可在任务配置中单独选择执行位置、引擎和审批。</div>
            <div className="settings-choice-list" role="group" aria-label="新会话默认执行配置">
              <Choice active={form.runtime === "pig"} title="本机 Pig" hint="在当前工作区执行，使用上面配置的模型。" onClick={() => patch({ runtime: "pig" })} />
              <Choice active={form.runtime === "codex"} title="本机 Codex" hint="通过 Codex CLI 执行，使用独立模型连接。" onClick={() => patch({ runtime: "codex" })} />
              <Choice active={form.runtime === "cloud"} title="远端执行" hint="交给已连接控制面调度，退出工作台后继续运行。" onClick={() => patch({ runtime: "cloud", cloudMode: "remote" })} />
            </div>
            <p className="settings-note">保存后的默认值：{surface.summary}</p>
            {form.runtime === "codex" && <>
              <label className="settings-check"><input type="checkbox" checked={form.codexNetworkAccess} onChange={e => patch({ codexNetworkAccess: e.target.checked })} /><span>允许 Codex 工作区访问外网<small>默认关闭；开启后允许下载和请求第三方服务。</small></span></label>
              <p className="settings-note">Codex 使用自己的工作区沙箱，文件操作不经过 Pig 写入审批。其网络权限不会开启完整系统访问。</p>
            </>}
            {form.runtime === "pig" && <p className="settings-note">本机 Pig 默认在主机执行命令。可在单个任务的执行配置中选择 Docker 隔离。</p>}
            {form.runtime === "cloud" && <button type="button" className="btn-quiet" onClick={() => setSection("remote")}>配置远端连接 →</button>}
          </>}
          {section === "workspace" && <>
            <div className="settings-scope">本机文件工具使用这个目录。项目自己的工作区配置保持独立。</div>
            <Field label="工作区根目录" hint="填写完整路径。工作区中的 Desktop 子目录不是系统桌面。"><input className="field" value={form.workspaceRoot} onChange={e => patch({ workspaceRoot: e.target.value })} placeholder="./sample-workspace" /></Field>
            {window.pigDesktop && <button type="button" className="btn-quiet" onClick={async () => { try { const folder = await window.pigDesktop?.chooseWorkspace(); if (folder) patch({ workspaceRoot: folder }); } catch { setError("无法打开文件夹选择器"); } }}>选择本机文件夹…</button>}
            <p className="settings-note">目录限制用于文件工具，不等于操作系统隔离。远端首轮上传过滤后的工作区快照，后续对话延续远端工作区；本机与远端成果分开保存。</p>
            <div className="settings-divider" />
            <h4>远端仓库</h4><p className="settings-note">可选，供远端任务准备仓库。不要在地址中放访问密钥。</p>
            <Field label="仓库 URL"><input className="field" value={form.cloudRepoUrl ?? ""} onChange={e => patch({ cloudRepoUrl: e.target.value })} placeholder="https://github.com/acme/app.git" /></Field>
            <Field label="仓库 Ref"><input className="field" value={form.cloudRepoRef ?? ""} onChange={e => patch({ cloudRepoRef: e.target.value })} placeholder="main" /></Field>
            {settings?.cloudStatus?.repoHint?.repoUrl && <p className="settings-note">当前生效仓库：{settings.cloudStatus.repoHint.repoUrl}{settings.cloudStatus.repoHint.ref ? ` @ ${settings.cloudStatus.repoHint.ref}` : ""}</p>}
          </>}
          {section === "remote" && <>
            <div className="settings-scope">会话与定时任务共用连接。任务由控制面授权、排队和分配 Runner。</div>
            <Field label="控制面地址" hint="填写服务根地址，不要包含 /v1。"><input className="field" value={form.cloudBaseUrl} onChange={e => patch({ cloudBaseUrl: e.target.value })} placeholder="http://127.0.0.1:8892" /></Field>
            <Field label="控制面 Token" hint={settings?.cloudStatus?.tokenPresent ? "已配置访问凭证；新凭证保存后生效。" : "使用管理员提供的令牌，或在下方兑换邀请码。"}><input className="field" type="password" autoComplete="off" value={form.cloudToken} onChange={e => patch({ cloudToken: e.target.value })} placeholder={settings?.cloudStatus?.tokenPresent ? "已配置；留空保留已保存值" : "填写访问令牌"} /></Field>
            <label className="settings-check"><input type="checkbox" checked={form.cloudMode === "remote"} onChange={e => patch({ cloudMode: e.target.checked ? "remote" : "local-stub" })} /><span>连接真实控制面<small>关闭后使用本机测试模式，不会调度远端 Runner。</small></span></label>
            <div className="settings-action-row"><button type="button" className="btn-secondary" disabled={form.cloudMode !== "remote"} onClick={() => void test(true)}>保存并检查控制面</button><p>检查访问身份，不调用模型。</p></div>
            <details className="settings-details"><summary>使用邀请码加入</summary><div>
              <Field label="一次性邀请码"><input className="field" type="password" autoComplete="off" value={invite} onChange={e => setInvite(e.target.value)} placeholder="管理员提供的邀请码" /></Field>
              <button type="button" className="btn-secondary" disabled={!invite.trim()} onClick={() => void acceptInvite()}>兑换邀请并连接</button>
            </div></details>
          </>}
          {section === "appearance" && <>
            <div className="settings-scope">仅影响这台设备，立即生效。不改变任务或控制面的配置。</div>
            <div className="settings-choice-list" role="group" aria-label="配色方案"><Choice title="浅色" hint="适合明亮环境" active={appearance === "light"} onClick={() => changeTheme("light")} /><Choice title="深色" hint="适合低光环境" active={appearance === "dark"} onClick={() => changeTheme("dark")} /></div>
            <p className="settings-note" role="status">已使用{appearance === "dark" ? "深色" : "浅色"}外观，刷新后保持。</p>
          </>}
          {section === "advanced" && <>
            <div className="settings-scope">用于排障和特殊执行环境。普通任务无需修改。</div>
            <Field label="Codex 二进制路径" hint="留空时从系统 PATH 查找 codex。"><input className="field" value={form.codexBinaryPath} onChange={e => patch({ codexBinaryPath: e.target.value })} placeholder="codex 或 /usr/local/bin/codex" /></Field>
            {settings?.codexStatus && <ul className="settings-status-list"><Status ok={settings.codexStatus.binaryFound} label="Codex 可执行文件" /><Status ok={settings.codexStatus.homeWritable} label="隔离 Codex 数据目录可写" /><Status ok={settings.codexStatus.apiKeyPresent} label="Codex 专用密钥" /></ul>}
            <details className="settings-details"><summary>配置来源与环境提示</summary><div>
              <p className="settings-note">{window.pigDesktop ? "设置保存在应用数据目录，密钥由系统加密保存。" : "设置保存在本机 data/settings.json，优先于 .env 和 .env.local。密钥应由本机文件权限保护，不要提交到仓库。"}</p>
              <p className="settings-note">远端非密钥提示优先级：本页设置 → env.json → PIG_CLOUD_REPO_* 环境变量。environment.json 提供依赖和安装提示；这些提示文件不应包含 Token 或 API Key。</p>
              <p className="settings-note">env.json：{settings?.cloudStatus?.envJson?.found ? "已发现" : "未找到"}。environment.json：{settings?.cloudStatus?.installHints ? "已发现" : "未找到"}。</p>
              {settings?.cloudStatus?.envJson?.found && <button type="button" className="btn-quiet" onClick={() => { const hints = settings.cloudStatus?.envJson; if (hints) patch({ cloudBaseUrl: form.cloudBaseUrl.trim() || hints.baseUrl || "", cloudRepoUrl: form.cloudRepoUrl?.trim() || hints.repoUrl || "", cloudRepoRef: form.cloudRepoRef?.trim() || hints.repoRef || "" }); }}>填入 env.json 提示</button>}
              {settings?.cloudStatus?.installHints && <pre className="settings-code">{JSON.stringify(settings.cloudStatus.installHints, null, 2)}</pre>}
            </div></details>
            <details className="settings-details"><summary>执行协议与能力边界</summary><div><p className="settings-note">Pig 使用 Chat Completions 工具调用。Codex 通过 codex exec --json 子进程使用 Responses 接口，并使用 workspace-write 沙箱；不会自动复用 Codex App 登录，也不桥接 Pig skills、update_plan 或细粒度 token 流。</p><p className="settings-note">远端使用控制面调度的独立容器。测试模式 local-stub 在本机复用 Pig 循环。全局并发、队列和 Runner 限制由管理端配置。</p></div></details>
            <h4>本地技能 <span className="settings-count">{skills.length}</span></h4>
            <ul className="settings-skill-list">{skills.length ? skills.map(skill => <li key={skill.name}><strong>{skill.name}</strong><span>{skill.description}</span></li>) : <li>还没有本地技能。可在 skills/ 中添加技能文件。</li>}</ul>
          </>}
          </fieldset>
        </div>
      </div>
      <footer className="settings-footer">
        <div className="settings-feedback">{error ? <p role="alert" className="text-danger">{error}</p> : feedback ? <p role="status" className="text-success">{feedback}</p> : <p>{dirty ? "有尚未保存的修改" : "设置已同步"}</p>}</div>
        <div className="settings-footer-actions"><button type="button" onClick={requestClose} disabled={saving} className="btn-quiet">取消</button><button type="button" onClick={() => void save()} disabled={saving || !settings} className="btn-primary">{saving ? "保存中…" : "保存"}</button></div>
      </footer>
      {discardOpen && <div ref={discardDialog} tabIndex={-1} className="settings-discard" role="alertdialog" aria-labelledby="discard-title" aria-describedby="discard-description"><h3 id="discard-title">放弃未保存的修改？</h3><p id="discard-description">关闭后，这次编辑的连接与执行配置不会保存。</p><div><button type="button" className="btn-quiet" onClick={() => setDiscardOpen(false)}>继续编辑</button><button type="button" className="btn-primary" onClick={() => { setDiscardOpen(false); onClose(); }}>放弃修改并关闭</button></div></div>}
    </div>
  </div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement }) {
  return <label className="settings-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Choice({ active, title, hint, onClick }: { active: boolean; title: string; hint: string; onClick: () => void }) {
  return <button type="button" className="settings-choice" aria-pressed={active} onClick={onClick}><span>{title}</span><small>{hint}</small></button>;
}
function Status({ ok, label }: { ok: boolean; label: string }) {
  return <li><span className={ok ? "text-success" : "text-warning"}>{ok ? "就绪" : "未就绪"}</span><span>{label}</span></li>;
}
