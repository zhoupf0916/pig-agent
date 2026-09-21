import { useEffect, useRef, useState } from "react";
import { useDialog } from "../lib/use-dialog";
import { describeExecutionSurface } from "../lib/runtime-surface";
import { applyOpenSettingsFormSnapshot } from "../lib/settings-surface-sync";
import type { AgentRuntime, CloudMode, Settings, SkillMeta } from "../types";

const emptyForm: Settings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  workspaceRoot: "",
  runtime: "pig",
  codexBinaryPath: "",
  codexModel: "deepseek-flash",
  codexApiKey: "",
  codexBaseUrl: "https://api.deepseek.com/",
  codexNetworkAccess: false,
  cloudBaseUrl: "",
  cloudToken: "",
  cloudMode: "local-stub",
  cloudRepoUrl: "",
  cloudRepoRef: "",
};

export function SettingsModal({
  open,
  settings,
  skills,
  onClose,
  onSave,
}: {
  open: boolean;
  settings: Settings | null;
  skills: SkillMeta[];
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => Promise<void>;
}) {
  const dialog = useDialog(open, onClose);
  const [form, setForm] = useState<Settings>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primedOpen = useRef(false);
  const [invite, setInvite] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");

  useEffect(() => {
    if (!open) {
      primedOpen.current = false;
      setError(null);
      return;
    }
    if (!settings) return;
    if (!primedOpen.current) {
      primedOpen.current = true;
      setForm({ ...emptyForm, ...settings });
    } else {
      setForm((prev) => applyOpenSettingsFormSnapshot(prev, settings));
    }
    setError(null);
  }, [open, settings]);

  const previewSurface = describeExecutionSurface({
    runtime: form.runtime,
    llmModel: form.llmModel,
    llmBaseUrl: form.llmBaseUrl,
    codexModel: form.codexModel,
    codexNetworkAccess: form.codexNetworkAccess,
    cloudMode: form.cloudMode,
    cloudBaseUrl: form.cloudBaseUrl,
    effectiveBaseUrl:
      form.cloudBaseUrl.trim() ||
      settings?.cloudStatus?.effectiveBaseUrl ||
      settings?.cloudBaseUrl,
  });
  const savedSurface = settings
    ? describeExecutionSurface({
        runtime: settings.runtime,
        llmModel: settings.llmModel,
        llmBaseUrl: settings.llmBaseUrl,
        codexModel: settings.codexModel,
        codexNetworkAccess: settings.codexNetworkAccess,
        cloudMode: settings.cloudMode,
        cloudBaseUrl: settings.cloudBaseUrl,
        effectiveBaseUrl:
          settings.cloudStatus?.effectiveBaseUrl || settings.cloudBaseUrl,
      })
    : previewSurface;

  if (!open) return null;

  const setRuntime = (runtime: AgentRuntime) => setForm({ ...form, runtime });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-ink-300 bg-panel p-5 shadow-lift">
        <div className="mb-4 flex shrink-0 items-start justify-between">
          <div>
            <h2 id="settings-title" className="text-base font-medium text-ink-800">设置</h2>
            <p className="mt-1 text-xs text-ink-500">
              {window.pigDesktop
                ? "设置保存在应用数据目录；密钥使用系统加密存储。密钥留空会保留已保存的值。"
                : "保存在本机 data/settings.json，覆盖 .env / .env.local。切勿把密钥提交到仓库。"}
            </p>
            <div className="mt-2 rounded-card border border-ink-300 bg-ink-100 px-3 py-2 text-xs text-ink-700">
              <div>
                当前执行面：
                <span className="font-medium text-ink-800">
                  {savedSurface.summary}
                </span>
              </div>
              {previewSurface.summary !== savedSurface.summary && (
                <div className="mt-1 text-ink-500">
                  将切换为：{previewSurface.summary}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 shrink-0 whitespace-nowrap text-xs text-ink-500 hover:text-ink-800"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          <Field label="新会话默认执行配置">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RuntimeChoice
                active={form.runtime === "pig"}
                title="本机 Pig（默认）"
                hint="OpenAI 兼容 tool-calling"
                onClick={() => setRuntime("pig")}
              />
              <RuntimeChoice
                active={form.runtime === "codex"}
                title="本机 Codex（可选）"
                hint="subprocess：codex exec --json"
                onClick={() => setRuntime("codex")}
              />
              <RuntimeChoice
                active={form.runtime === "cloud"}
                title="云端（可选）"
                hint="同一协议 · 隔离执行面"
                onClick={() => setRuntime("cloud")}
              />
            </div>
          </Field>
          {form.runtime === "pig" && (
            <p className="text-meta leading-relaxed text-ink-600">
              密钥无效、网关不可达或工具连续失败时会显示中文原因，并可「重试本轮」（不重复插入用户消息）。会话回到
              idle，不会卡在运行中。
            </p>
          )}

          <details
            open={form.runtime === "cloud"}
            className="rounded-card border border-ink-300 p-3"
          >
            <summary className="cursor-pointer text-sm font-medium">
              远端控制面连接（会话与定时任务共用）
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-meta leading-relaxed text-ink-600">
                配置地址和令牌后，在会话或自动化中选择远端执行。远端计划由控制面调度，退出工作台仍会执行。当前远端执行支持
                Pig 引擎。
              </p>
              <p className="text-xs text-ink-700">
                生效：
                <span className="font-medium">{previewSurface.summary}</span>
              </p>
              <Field label="云端模式">
                <div className="grid grid-cols-2 gap-2">
                  <RuntimeChoice
                    active={form.cloudMode !== "remote"}
                    title="local-stub"
                    hint="本机隔离桩 · 测试默认"
                    onClick={() =>
                      setForm({
                        ...form,
                        cloudMode: "local-stub" satisfies CloudMode,
                      })
                    }
                  />
                  <RuntimeChoice
                    active={form.cloudMode === "remote"}
                    title="remote"
                    hint="远程控制面 URL"
                    onClick={() => setForm({ ...form, cloudMode: "remote" })}
                  />
                </div>
              </Field>
              <Field label="控制面 Base URL（remote；不要带 /v1）">
                <input
                  value={form.cloudBaseUrl}
                  onChange={(e) =>
                    setForm({ ...form, cloudBaseUrl: e.target.value })
                  }
                  className="field"
                  placeholder="http://127.0.0.1:8080"
                />
              </Field>
              <Field label="首次加入：管理员提供的一次性邀请码">
                <input className="field" type="password" value={invite} onChange={e=>setInvite(e.target.value)} placeholder="填写上方控制面地址后兑换" autoComplete="off" />
                <button type="button" className="btn-ghost mt-2" disabled={saving || !invite.trim()} onClick={async()=>{
                  setSaving(true);setError(null);
                  try {
                    const response=await fetch("/api/remote/accept-invite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({baseUrl:form.cloudBaseUrl,invite:invite.trim()})});
                    const data=await response.json();if(!response.ok)throw Error(data.error);
                    const next={...form,cloudMode:"remote" as const,cloudToken:data.token};
                    setForm(next);await onSave(next);setInvite("");setConnectionStatus(`已加入：${data.account.name}。访问会话有效期 30 天。`);
                    if(window.pigDesktop)setForm({...next,cloudToken:""});
                  }catch(e){setError(e instanceof Error?e.message:"加入失败");}finally{setSaving(false);}
                }}>兑换邀请并连接</button>
              </Field>
              <Field label="控制面 Token（已有账号可直接填写）">
                <input
                  type="password"
                  value={form.cloudToken}
                  onChange={(e) =>
                    setForm({ ...form, cloudToken: e.target.value })
                  }
                  className="field"
                  placeholder="Bearer token 或从 PIG_CLOUD_TOKEN 读取"
                />
              </Field>
              {form.cloudMode === "remote" && (
                <div className="space-y-3 rounded-card border border-ink-300 bg-panel p-3">
                  <p className="text-meta leading-relaxed text-ink-600">
                    非密钥仓库提示（create-run 的{" "}
                    <code className="font-mono text-ink-800">repoUrl</code> /{" "}
                    <code className="font-mono text-ink-800">ref</code>
                    ）。优先级：本页填写 &gt; 仓库根目录{" "}
                    <code className="font-mono text-ink-800">
                      env.json
                    </code>{" "}
                    &gt; 环境变量{" "}
                    <code className="font-mono text-ink-800">
                      PIG_CLOUD_REPO_*
                    </code>
                    。Token / API Key 不要写入 env.json /
                    environment.json。安装提示（deps / tools / setup）见{" "}
                    <code className="font-mono text-ink-800">
                      environment.json.example
                    </code>
                    ，只指导 worker 预备，不会写入密钥。
                  </p>
                  <Field label="仓库 URL（可选；remote clone hint）">
                    <input
                      value={form.cloudRepoUrl ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, cloudRepoUrl: e.target.value })
                      }
                      className="field"
                      placeholder="https://github.com/acme/app.git"
                    />
                  </Field>
                  <Field label="仓库 Ref（可选）">
                    <input
                      value={form.cloudRepoRef ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, cloudRepoRef: e.target.value })
                      }
                      className="field"
                      placeholder="main"
                    />
                  </Field>
                  {settings?.cloudStatus?.envJson?.found &&
                    (settings.cloudStatus.envJson.baseUrl ||
                      settings.cloudStatus.envJson.repoUrl ||
                      settings.cloudStatus.envJson.repoRef) && (
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => {
                          const hints = settings.cloudStatus?.envJson;
                          if (!hints) return;
                          setForm({
                            ...form,
                            cloudBaseUrl:
                              form.cloudBaseUrl.trim() ||
                              hints.baseUrl ||
                              form.cloudBaseUrl,
                            cloudRepoUrl:
                              (form.cloudRepoUrl ?? "").trim() ||
                              hints.repoUrl ||
                              form.cloudRepoUrl,
                            cloudRepoRef:
                              (form.cloudRepoRef ?? "").trim() ||
                              hints.repoRef ||
                              form.cloudRepoRef,
                          });
                        }}
                      >
                        填入 env.json 提示
                      </button>
                    )}
                </div>
              )}
              {settings?.cloudStatus && (
                <ul className="space-y-1 text-meta text-ink-600">
                  <StatusLine
                    ok={
                      settings.cloudStatus.mode === "local-stub" ||
                      settings.cloudStatus.remoteUrlConfigured
                    }
                    label={
                      settings.cloudStatus.mode === "remote"
                        ? "远程控制面 URL 已配置"
                        : "local-stub（无需集群）"
                    }
                  />
                  <StatusLine
                    ok={
                      settings.cloudStatus.tokenPresent ||
                      settings.cloudStatus.mode === "local-stub"
                    }
                    label="控制面 Token（remote 可选）"
                  />
                  <StatusLine
                    ok={Boolean(settings.cloudStatus.envJson?.found)}
                    label={
                      settings.cloudStatus.envJson?.found
                        ? `env.json 已发现${formatEnvJsonHints(settings.cloudStatus.envJson)}`
                        : "env.json 未找到（可复制 env.json.example）"
                    }
                  />
                  {settings.cloudStatus.repoHint?.repoUrl && (
                    <StatusLine
                      ok
                      label={`生效仓库 ${settings.cloudStatus.repoHint.repoUrl}${
                        settings.cloudStatus.repoHint.ref
                          ? `@${settings.cloudStatus.repoHint.ref}`
                          : ""
                      }（${hintSourceLabel(settings.cloudStatus.repoHint.repoUrlSource)}）`}
                    />
                  )}
                  <StatusLine
                    ok={Boolean(settings.cloudStatus.installHints)}
                    label={
                      settings.cloudStatus.installHints
                        ? `environment.json 安装提示${formatInstallHints(settings.cloudStatus.installHints)}`
                        : "environment.json 安装提示未找到（可复制 environment.json.example）"
                    }
                  />
                </ul>
              )}
            </div>
          </details>

          {form.runtime === "codex" && (
            <div className="space-y-3 rounded-card border border-accent bg-accent-soft p-3">
              <p className="text-meta leading-relaxed text-ink-600">
                Codex CLI 负责规划和工具执行，模型由下面的 Responses 接口提供。
                它使用独立密钥，不会自动使用 Pig 的密钥，也不使用此电脑上 Codex
                App 的登录账号。 多轮由工作台传入近期对话；Codex
                文件操作使用自身的 workspace-write 沙箱，不经过 Pig 的写入审批。
              </p>
              <Field label="Codex 二进制路径（可选，留空则用 PATH 中的 codex）">
                <input
                  value={form.codexBinaryPath}
                  onChange={(e) =>
                    setForm({ ...form, codexBinaryPath: e.target.value })
                  }
                  className="field"
                  placeholder="codex 或 /usr/local/bin/codex"
                />
              </Field>
              <Field label="Codex Responses 接口地址">
                <input
                  className="field"
                  value={form.codexBaseUrl ?? "https://api.deepseek.com/"}
                  onChange={(e) =>
                    setForm({ ...form, codexBaseUrl: e.target.value })
                  }
                  placeholder="https://api.deepseek.com/"
                />
              </Field>
              <Field label="Codex 专用 API Key">
                <input
                  className="field"
                  type="password"
                  autoComplete="off"
                  value={form.codexApiKey ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, codexApiKey: e.target.value })
                  }
                  placeholder={
                    settings?.codexApiKeyConfigured
                      ? "已保存；留空保持不变"
                      : "填写 Responses 提供商的密钥"
                  }
                />
                <button
                  type="button"
                  className="btn-ghost mt-2 text-xs"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setError(null);
                    try {
                      await onSave(form);
                      const response = await fetch(
                        "/api/settings/codex/use-pig-key",
                        { method: "POST" },
                      );
                      const result = await response.json();
                      if (!response.ok)
                        throw new Error(result.error || "无法复用密钥");
                      setForm((value) => ({
                        ...value,
                        codexApiKey: "",
                        codexApiKeyConfigured: true,
                      }));
                      setConnectionStatus(
                        "已将同一提供商的 Pig 密钥保存为 Codex 专用密钥，可继续测试连接。",
                      );
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "保存失败");
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  同一提供商：使用已保存的 Pig 密钥
                </button>
                <p className="mt-1 text-xs text-ink-500">
                  桌面版加密保存；源码 Web 版保存在本机设置文件，也可使用
                  CODEX_API_KEY 环境变量。
                </p>
              </Field>
              <Field label="Codex 模型">
                <input
                  value={form.codexModel}
                  onChange={(e) =>
                    setForm({ ...form, codexModel: e.target.value })
                  }
                  className="field"
                  placeholder="deepseek-flash"
                />
              </Field>
              <label className="flex items-start gap-2 rounded-card border border-ink-300 bg-panel px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.codexNetworkAccess}
                  onChange={(e) =>
                    setForm({ ...form, codexNetworkAccess: e.target.checked })
                  }
                />
                <span>
                  <span className="text-xs text-ink-800">
                    允许 Codex 工作区外发网络
                  </span>
                  <span className="mt-0.5 block text-meta text-ink-500">
                    默认关闭（sandbox_workspace_write.network_access=false）。显式勾选才会放开出站网络。
                  </span>
                </span>
              </label>
              {form.codexNetworkAccess && (
                <div className="rounded-card border border-warning bg-warning-soft px-3 py-2 text-meta leading-relaxed text-warning">
                  警告：开启后 Codex 的 workspace-write
                  沙箱可以访问外网（下载、请求第三方 API
                  等）。只在你信任当前工作区与任务时启用。不会开启
                  danger-full-access。
                </div>
              )}
              {settings?.codexStatus && (
                <ul className="space-y-1 text-meta text-ink-600">
                  <StatusLine
                    ok={settings.codexStatus.binaryFound}
                    label="找到 Codex 二进制"
                  />
                  <StatusLine
                    ok={settings.codexStatus.homeWritable}
                    label="隔离 CODEX_HOME 可写"
                  />
                  <StatusLine
                    ok={settings.codexStatus.apiKeyPresent}
                    label="Codex 专用密钥已配置"
                  />
                </ul>
              )}
            </div>
          )}

          <Field label="LLM Base URL（Pig 运行时 / Chat Completions）">
            <input
              value={form.llmBaseUrl}
              onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
              className="field"
              placeholder="https://api.deepseek.com/v1"
            />
          </Field>
          <Field label="API Key（Pig 运行时；DeepSeek / OpenAI 兼容；Ollama 可留空）">
            <input
              type="password"
              value={form.llmApiKey}
              onChange={(e) => setForm({ ...form, llmApiKey: e.target.value })}
              className="field"
              placeholder={
                window.pigDesktop
                  ? settings?.llmApiKeyConfigured
                    ? "已安全保存；留空保持不变"
                    : "输入 API Key"
                  : "sk-… 或从 DEEPSEEK_API_KEY 读取"
              }
            />
          </Field>
          <Field label="Pig 模型">
            <input
              value={form.llmModel}
              onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
              className="field"
              placeholder="deepseek-chat"
            />
          </Field>
          <Field label="工作区根目录（文件工具的访问范围）">
            {window.pigDesktop && (
              <button
                type="button"
                className="mb-2 text-xs text-accent"
                onClick={async () => {
                  try {
                    const folder = await window.pigDesktop?.chooseWorkspace();
                    if (folder)
                      setForm((value) => ({ ...value, workspaceRoot: folder }));
                  } catch {
                    setError("无法打开文件夹选择器");
                  }
                }}
              >
                选择本机文件夹…
              </button>
            )}
            <input
              value={form.workspaceRoot}
              onChange={(e) =>
                setForm({ ...form, workspaceRoot: e.target.value })
              }
              className="field"
              placeholder="./sample-workspace"
            />
            <p className="mt-1 text-xs leading-5 text-ink-500">
              文件写入此目录。要操作真实桌面，请填写桌面的完整路径；工作区里的
              Desktop 子目录不是系统桌面。 本机 Pig
              默认在主机执行命令；可在任务的「执行与验收」中选择
              Docker。文件访问范围本身不等于操作系统隔离。
            </p>
          </Field>

        {form.runtime !== "cloud" && (
          <div className="mt-4 rounded-card border border-ink-300 p-3">
            <button
              type="button"
              disabled={saving}
              className="btn-ghost"
              onClick={async () => {
                setSaving(true);
                setError(null);
                setConnectionStatus("");
                try {
                  await onSave(form);
                  const response = await fetch(
                    "/api/settings/test-connection",
                    { method: "POST" },
                  );
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error || "连接失败");
                  setForm((value) => ({
                    ...value,
                    codexApiKey: "",
                    ...(window.pigDesktop
                      ? { llmApiKey: "", cloudToken: "" }
                      : {}),
                  }));
                  setConnectionStatus(
                    form.runtime === "codex"
                      ? "Codex CLI 已实际启动并收到模型回复。"
                      : "模型连接成功。",
                  );
                } catch (err) {
                  setError(err instanceof Error ? err.message : "连接失败");
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "正在检测…" : "保存并测试当前运行时"}
            </button>
            <p className="mt-1 text-xs text-ink-500">
              测试会发起一次简短模型请求。Codex
              测试在临时目录进行，不修改当前工作区。
            </p>
            {connectionStatus && (
              <p role="status" className="mt-2 text-sm text-success">
                {connectionStatus}
              </p>
            )}
          </div>
        )}
        <div className="mt-4 rounded-card border border-ink-300 bg-ink-100 p-3">
          <div className="text-meta uppercase tracking-[0.14em] text-ink-500">
            本地技能
          </div>
          <ul className="mt-2 space-y-1.5">
            {skills.map((s) => (
              <li key={s.name} className="text-xs text-ink-700">
                <span className="font-mono text-accent">{s.name}</span>
                <span className="text-ink-500"> — {s.description}</span>
              </li>
            ))}
            {skills.length === 0 && (
              <li className="text-xs text-ink-500">skills/ 下还没有技能文件</li>
            )}
          </ul>
          {form.runtime === "codex" && (
            <p className="mt-2 text-meta text-ink-500">
              Codex MVP 不桥接 Pig skills / update_plan / 细粒度 token 流。
            </p>
          )}
          {form.runtime === "cloud" && form.cloudMode === "local-stub" && (
            <p className="mt-2 text-meta text-ink-500">
              local-stub 复用本机 Pig 循环，技能与计划卡片与默认运行时一致。
            </p>
          )}
          {form.runtime === "cloud" && form.cloudMode === "remote" && (
            <p className="mt-2 text-meta text-ink-500">
              远端任务由控制面调度，在独立容器中执行。首轮上传工作目录的安全快照（跳过密钥、.env、.git 和 node_modules），后续对话延续远端工作区。关闭窗口不会停止任务；可在远端运行记录中查看状态、审批操作并下载成果。
            </p>
          )}
        </div>

        </div>

        {error && <p role="alert" className="mt-3 shrink-0 text-xs text-danger">{error}</p>}

        <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-ink-300 pt-3">
          <button type="button" onClick={onClose} className="btn-quiet">
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onSave(form)
                .then(onClose)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setSaving(false));
            }}
            className="btn-primary"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeChoice({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-card border px-3 py-2 text-left ${
        active
          ? "border-accent bg-accent-soft text-ink-800"
          : "border-ink-300 bg-panel text-ink-700 hover:border-ink-400 hover:bg-ink-100"
      }`}
    >
      <div className="text-xs font-medium">{title}</div>
      <div className="mt-0.5 text-meta text-ink-500">{hint}</div>
    </button>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <span className={ok ? "text-success" : "text-warning"}>
        {ok ? "就绪" : "未就绪"}
      </span>
      <span className="text-ink-500"> · {label}</span>
    </li>
  );
}

function hintSourceLabel(source: string | undefined): string {
  if (source === "settings") return "Settings";
  if (source === "env.json") return "env.json";
  if (source === "env") return "环境变量";
  return "未设置";
}

function formatInstallHints(hints: {
  install?: string;
  deps?: string[];
  tools?: string[];
  setup?: string[];
}): string {
  const bits = [
    hints.install ? `install=${hints.install}` : "",
    hints.deps?.length ? `deps=${hints.deps.join(",")}` : "",
    hints.tools?.length ? `tools=${hints.tools.join(",")}` : "",
    hints.setup?.length ? `setup=${hints.setup.join(",")}` : "",
  ].filter(Boolean);
  return bits.length ? `：${bits.join(" · ")}` : "";
}

function formatEnvJsonHints(hints: {
  baseUrl?: string;
  repoUrl?: string;
  repoRef?: string;
}): string {
  const bits = [
    hints.baseUrl ? `baseUrl=${hints.baseUrl}` : "",
    hints.repoUrl ? `repoUrl=${hints.repoUrl}` : "",
    hints.repoRef ? `ref=${hints.repoRef}` : "",
  ].filter(Boolean);
  return bits.length ? `：${bits.join(" · ")}` : "";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-meta text-ink-500">{label}</div>
      {children}
    </label>
  );
}
