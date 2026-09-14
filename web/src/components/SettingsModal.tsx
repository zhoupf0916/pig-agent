import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (open && settings) setForm({ ...emptyForm, ...settings });
    setError(null);
  }, [open, settings]);

  if (!open) return null;

  const setRuntime = (runtime: AgentRuntime) => setForm({ ...form, runtime });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-800/20 p-4 backdrop-blur-[2px]">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-card border border-ink-300 bg-white p-5 shadow-lift">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium text-ink-800">设置</h2>
            <p className="mt-1 text-xs text-ink-500">
              保存在本机 data/settings.json，覆盖 .env / .env.local。默认本机 Pig + DeepSeek
              Chat Completions。Codex 与云端为可选执行面。切勿把密钥提交到仓库。
            </p>
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

          {form.runtime === "cloud" && (
            <div className="space-y-3 rounded-card border border-accent/25 bg-accent-soft p-3">
              <p className="text-meta leading-relaxed text-ink-600">
                工作台会话 / 计划 / 工具 / 产物语义不变，只换执行面。默认{" "}
                <code className="font-mono text-ink-800">local-stub</code>
                ：在 <code className="font-mono text-ink-800">data/cloud-runs/&lt;id&gt;/</code>{" "}
                隔离工作区副本上跑本机 Pig 循环，密钥留在本机控制路径，不会写入 run 目录或提交
                git。远程模式指向未来控制面（create-run → SSE → IDLE / abort），见{" "}
                <code className="font-mono text-ink-800">docs/cloud-runtime.md</code>。
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
                </ul>
              )}
            </div>
          )}

          {form.runtime === "codex" && (
            <div className="space-y-3 rounded-card border border-accent/25 bg-accent-soft p-3">
              <p className="text-meta leading-relaxed text-ink-600">
                DeepSeek 走隔离 CODEX_HOME + <code className="font-mono text-ink-800">wire_api=responses</code>
                ，模型如 <code className="font-mono text-ink-800">deepseek-flash</code>
                。不会把 Pig 的 Chat Completions <code className="font-mono text-ink-800">llmBaseUrl</code>
                （…/v1）映射进 Codex。密钥只用环境变量{" "}
                <code className="font-mono text-ink-800">DEEPSEEK_API_KEY</code> /{" "}
                <code className="font-mono text-ink-800">CODEX_API_KEY</code>。多轮只拼最近若干条文本，没有
                Codex 原生跨轮记忆。
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
              <label className="flex items-start gap-2 rounded-card border border-ink-300 bg-white px-3 py-2">
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
                <div className="rounded-card border border-warning/40 bg-warning-soft px-3 py-2 text-meta leading-relaxed text-warning">
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
          <Field label="工作区根目录（沙箱，不可逃逸）">
            <input
              value={form.workspaceRoot}
              onChange={(e) => setForm({ ...form, workspaceRoot: e.target.value })}
              className="field"
              placeholder="./sample-workspace"
            />
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
              远程控制面若下发 plan / artifact 事件，工作台会按现有卡片渲染；未下发则该轮没有步骤条。
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
          : "border-ink-300 bg-white text-ink-700 hover:border-ink-400 hover:bg-ink-100"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-meta text-ink-500">{label}</div>
      {children}
    </label>
  );
}
