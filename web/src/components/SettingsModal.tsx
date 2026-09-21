import { useEffect, useRef, useState } from "react";
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
  const [form, setForm] = useState<Settings>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primedOpen = useRef(false);

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
      form.cloudBaseUrl.trim() || settings?.cloudStatus?.effectiveBaseUrl || settings?.cloudBaseUrl,
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
        effectiveBaseUrl: settings.cloudStatus?.effectiveBaseUrl || settings.cloudBaseUrl,
      })
    : previewSurface;

  if (!open) return null;

  const setRuntime = (runtime: AgentRuntime) => setForm({ ...form, runtime });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-card border border-ink-300 bg-panel p-5 shadow-lift">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium text-ink-800">设置</h2>
            <p className="mt-1 text-xs text-ink-500">
              保存在本机 data/settings.json，覆盖 .env / .env.local。默认本机 Pig + DeepSeek
              Chat Completions。Codex 与云端为可选执行面。切勿把密钥提交到仓库。
            </p>
            <div className="mt-2 rounded-card border border-ink-300 bg-ink-100 px-3 py-2 text-xs text-ink-700">
              <div>
                当前执行面：<span className="font-medium text-ink-800">{savedSurface.summary}</span>
              </div>
              {previewSurface.summary !== savedSurface.summary && (
                <div className="mt-1 text-ink-500">将切换为：{previewSurface.summary}</div>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-ink-500 hover:text-ink-800">
            关闭
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Agent 运行时">
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

          {form.runtime === "cloud" && (
            <div className="space-y-3 rounded-card border border-accent bg-accent-soft p-3">
              <p className="text-meta leading-relaxed text-ink-600">
                工作台会话 / 计划 / 工具 / 产物语义不变，只换执行面。默认{" "}
                <code className="font-mono text-ink-800">local-stub</code>
                ：在 <code className="font-mono text-ink-800">data/cloud-runs/&lt;id&gt;/</code>{" "}
                隔离工作区副本上跑本机 Pig 循环，密钥留在本机控制路径，不会写入 run 目录或提交
                git。远程模式指向控制面（create-run 带工作区 snapshot → SSE → IDLE follow-up / abort），见{" "}
                <code className="font-mono text-ink-800">docs/cloud-runtime.md</code>。
              </p>
              <p className="text-xs text-ink-700">
                生效：<span className="font-medium">{previewSurface.summary}</span>
              </p>
              <Field label="云端模式">
                <div className="grid grid-cols-2 gap-2">
                  <RuntimeChoice
                    active={form.cloudMode !== "remote"}
                    title="local-stub"
                    hint="本机隔离桩 · 测试默认"
                    onClick={() => setForm({ ...form, cloudMode: "local-stub" satisfies CloudMode })}
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
                  onChange={(e) => setForm({ ...form, cloudBaseUrl: e.target.value })}
                  className="field"
                  placeholder="http://127.0.0.1:8080"
                />
              </Field>
              <Field label="控制面 Token（可选；只放本机，勿提交）">
                <input
                  type="password"
                  value={form.cloudToken}
                  onChange={(e) => setForm({ ...form, cloudToken: e.target.value })}
                  className="field"
                  placeholder="Bearer token 或从 PIG_CLOUD_TOKEN 读取"
                />
              </Field>
              {form.cloudMode === "remote" && (
                <div className="space-y-3 rounded-card border border-ink-300 bg-panel p-3">
                  <p className="text-meta leading-relaxed text-ink-600">
                    非密钥仓库提示（create-run 的 <code className="font-mono text-ink-800">repoUrl</code> /{" "}
                    <code className="font-mono text-ink-800">ref</code>
                    ）。优先级：本页填写 &gt; 仓库根目录{" "}
                    <code className="font-mono text-ink-800">env.json</code> &gt; 环境变量{" "}
                    <code className="font-mono text-ink-800">PIG_CLOUD_REPO_*</code>
                    。Token / API Key 不要写入 env.json / environment.json。安装提示（deps / tools / setup）见{" "}
                    <code className="font-mono text-ink-800">environment.json.example</code>
                    ，只指导 worker 预备，不会写入密钥。
                  </p>
                  <Field label="仓库 URL（可选；remote clone hint）">
                    <input
                      value={form.cloudRepoUrl ?? ""}
                      onChange={(e) => setForm({ ...form, cloudRepoUrl: e.target.value })}
                      className="field"
                      placeholder="https://github.com/acme/app.git"
                    />
                  </Field>
                  <Field label="仓库 Ref（可选）">
                    <input
                      value={form.cloudRepoRef ?? ""}
                      onChange={(e) => setForm({ ...form, cloudRepoRef: e.target.value })}
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
                            cloudBaseUrl: form.cloudBaseUrl.trim() || hints.baseUrl || form.cloudBaseUrl,
                            cloudRepoUrl: (form.cloudRepoUrl ?? "").trim() || hints.repoUrl || form.cloudRepoUrl,
                            cloudRepoRef: (form.cloudRepoRef ?? "").trim() || hints.repoRef || form.cloudRepoRef,
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
                    ok={settings.cloudStatus.mode === "local-stub" || settings.cloudStatus.remoteUrlConfigured}
                    label={
                      settings.cloudStatus.mode === "remote"
                        ? "远程控制面 URL 已配置"
                        : "local-stub（无需集群）"
                    }
                  />
                  <StatusLine
                    ok={settings.cloudStatus.tokenPresent || settings.cloudStatus.mode === "local-stub"}
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
                        settings.cloudStatus.repoHint.ref ? `@${settings.cloudStatus.repoHint.ref}` : ""
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
          )}

          {form.runtime === "codex" && (
            <div className="space-y-3 rounded-card border border-accent bg-accent-soft p-3">
              <p className="text-meta leading-relaxed text-ink-600">
                DeepSeek 走隔离 CODEX_HOME + <code className="font-mono text-ink-800">wire_api=responses</code>
                ，模型如 <code className="font-mono text-ink-800">deepseek-flash</code>
                。不会把 Pig 的 Chat Completions <code className="font-mono text-ink-800">llmBaseUrl</code>
                （…/v1）映射进 Codex。密钥只用环境变量{" "}
                <code className="font-mono text-ink-800">DEEPSEEK_API_KEY</code> /{" "}
                <code className="font-mono text-ink-800">CODEX_API_KEY</code>。多轮只拼最近若干条文本，没有
                Codex 原生跨轮记忆。缺少二进制、启动失败或本轮会话出错时会显示中文原因，并可「重试本轮」（不重复插入用户消息）。会话回到
                idle，不会卡在运行中。
              </p>
              <Field label="Codex 二进制路径（可选，留空则用 PATH 中的 codex）">
                <input
                  value={form.codexBinaryPath}
                  onChange={(e) => setForm({ ...form, codexBinaryPath: e.target.value })}
                  className="field"
                  placeholder="codex 或 /usr/local/bin/codex"
                />
              </Field>
              <Field label="Codex 模型">
                <input
                  value={form.codexModel}
                  onChange={(e) => setForm({ ...form, codexModel: e.target.value })}
                  className="field"
                  placeholder="deepseek-flash"
                />
              </Field>
              <label className="flex items-start gap-2 rounded-card border border-ink-300 bg-panel px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.codexNetworkAccess}
                  onChange={(e) => setForm({ ...form, codexNetworkAccess: e.target.checked })}
                />
                <span>
                  <span className="text-xs text-ink-800">允许 Codex 工作区外发网络</span>
                  <span className="mt-0.5 block text-meta text-ink-500">
                    默认关闭（sandbox_workspace_write.network_access=false）。显式勾选才会放开出站网络。
                  </span>
                </span>
              </label>
              {form.codexNetworkAccess && (
                <div className="rounded-card border border-warning bg-warning-soft px-3 py-2 text-meta leading-relaxed text-warning">
                  警告：开启后 Codex 的 workspace-write 沙箱可以访问外网（下载、请求第三方 API
                  等）。只在你信任当前工作区与任务时启用。不会开启 danger-full-access。
                </div>
              )}
              {settings?.codexStatus && (
                <ul className="space-y-1 text-meta text-ink-600">
                  <StatusLine ok={settings.codexStatus.binaryFound} label="找到 Codex 二进制" />
                  <StatusLine ok={settings.codexStatus.homeWritable} label="隔离 CODEX_HOME 可写" />
                  <StatusLine
                    ok={settings.codexStatus.apiKeyPresent}
                    label="环境变量中有 DEEPSEEK_API_KEY 或 CODEX_API_KEY"
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
              placeholder="sk-… 或从 DEEPSEEK_API_KEY 读取"
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
            <input
              value={form.workspaceRoot}
              onChange={(e) => setForm({ ...form, workspaceRoot: e.target.value })}
              className="field"
              placeholder="./sample-workspace"
            />
            <p className="mt-1 text-xs leading-5 text-ink-500">
              文件写入此目录。要操作真实桌面，请填写桌面的完整路径；工作区里的 Desktop 子目录不是系统桌面。
              本机 Pig 的命令在主机执行，此范围限制不等于 Docker 或虚拟机隔离。
            </p>
          </Field>
        </div>

        <div className="mt-4 rounded-card border border-ink-300 bg-ink-100 p-3">
          <div className="text-meta uppercase tracking-[0.14em] text-ink-500">本地技能</div>
          <ul className="mt-2 space-y-1.5">
            {skills.map((s) => (
              <li key={s.name} className="text-xs text-ink-700">
                <span className="font-mono text-accent">{s.name}</span>
                <span className="text-ink-500"> — {s.description}</span>
              </li>
            ))}
            {skills.length === 0 && <li className="text-xs text-ink-500">skills/ 下还没有技能文件</li>}
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
              远程首轮会上传沙箱安全快照（跳过 .env* / 密钥 / node_modules / .git）。create-run 等待期间步骤条显示中文进度（准备快照 / 创建运行 / 连接事件流）；已有 remoteRunId 的 follow-up / 重连事件流显示继续跟进 / 重新连接事件流，完成后进入推流或失败横幅。仓库提示来自本页、env.json 或 PIG_CLOUD_REPO_*。同一会话后续消息优先 follow-up；断连 / 超时 / 过期会显示中文原因并可重试（继续跟进或重新创建运行）。停止后下一轮可继续发送，不会留下僵尸运行。控制面若下发 plan / artifact 事件，工作台会按现有卡片渲染。密钥不会出现在进度或错误横幅里。
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
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
      <span className={ok ? "text-success" : "text-warning"}>{ok ? "就绪" : "未就绪"}</span>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-meta text-ink-500">{label}</div>
      {children}
    </label>
  );
}
