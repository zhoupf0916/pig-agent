import { useEffect, useState } from "react";
import type { AgentRuntime, Settings, SkillMeta } from "../types";

const emptyForm: Settings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  workspaceRoot: "",
  runtime: "pig",
  codexBinaryPath: "",
  codexModel: "deepseek-flash",
  codexNetworkAccess: false,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-ink-900 p-5 shadow-panel">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium text-white">设置</h2>
            <p className="mt-1 text-xs text-ink-500">
              保存在本机 data/settings.json，覆盖 .env / .env.local。默认 Pig 运行时 + DeepSeek
              Chat Completions。Codex 为可选后端。切勿把密钥提交到仓库。
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-ink-500 hover:text-white">
            关闭
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Agent 运行时">
            <div className="grid grid-cols-2 gap-2">
              <RuntimeChoice
                active={form.runtime !== "codex"}
                title="Pig（默认）"
                hint="OpenAI 兼容 tool-calling"
                onClick={() => setRuntime("pig")}
              />
              <RuntimeChoice
                active={form.runtime === "codex"}
                title="Codex（可选）"
                hint="subprocess：codex exec --json"
                onClick={() => setRuntime("codex")}
              />
            </div>
          </Field>

          {form.runtime === "codex" && (
            <div className="space-y-3 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3">
              <p className="text-[11px] leading-relaxed text-ink-400">
                DeepSeek 走隔离 CODEX_HOME + <code className="text-ink-300">wire_api=responses</code>
                ，模型如 <code className="text-ink-300">deepseek-flash</code>
                。不会把 Pig 的 Chat Completions <code className="text-ink-300">llmBaseUrl</code>
                （…/v1）映射进 Codex。密钥只用环境变量{" "}
                <code className="text-ink-300">DEEPSEEK_API_KEY</code> /{" "}
                <code className="text-ink-300">CODEX_API_KEY</code>。多轮只拼最近若干条文本，没有
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
              <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.codexNetworkAccess}
                  onChange={(e) => setForm({ ...form, codexNetworkAccess: e.target.checked })}
                />
                <span>
                  <span className="text-xs text-ink-200">允许 Codex 工作区外发网络</span>
                  <span className="mt-0.5 block text-[11px] text-ink-500">
                    默认关闭（sandbox_workspace_write.network_access=false）。显式勾选才会放开出站网络。
                  </span>
                </span>
              </label>
              {form.codexNetworkAccess && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
                  警告：开启后 Codex 的 workspace-write 沙箱可以访问外网（下载、请求第三方 API
                  等）。只在你信任当前工作区与任务时启用。不会开启 danger-full-access。
                </div>
              )}
              {settings?.codexStatus && (
                <ul className="space-y-1 text-[11px] text-ink-400">
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

        <div className="mt-4 rounded-xl border border-white/5 bg-ink-850 p-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-500">本地技能</div>
          <ul className="mt-2 space-y-1.5">
            {skills.map((s) => (
              <li key={s.name} className="text-xs text-ink-300">
                <span className="font-mono text-accent">{s.name}</span>
                <span className="text-ink-500"> — {s.description}</span>
              </li>
            ))}
            {skills.length === 0 && <li className="text-xs text-ink-500">skills/ 下还没有技能文件</li>}
          </ul>
          {form.runtime === "codex" && (
            <p className="mt-2 text-[11px] text-ink-500">
              Codex MVP 不桥接 Pig skills / update_plan / 细粒度 token 流。
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-300">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs text-ink-300 hover:bg-ink-800">
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
            className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-ink-950 hover:bg-sky-300 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      <style>{`
        .field {
          width: 100%;
          border-radius: 0.6rem;
          border: 1px solid rgba(255,255,255,0.08);
          background: #11141a;
          padding: 0.55rem 0.7rem;
          font-size: 13px;
          color: white;
        }
      `}</style>
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
      className={`rounded-xl border px-3 py-2 text-left ${
        active ? "border-accent/50 bg-accent/10 text-white" : "border-white/10 bg-ink-850 text-ink-300"
      }`}
    >
      <div className="text-xs font-medium">{title}</div>
      <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div>
    </button>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <span className={ok ? "text-emerald-300" : "text-amber-200"}>{ok ? "就绪" : "未就绪"}</span>
      <span className="text-ink-500"> · {label}</span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] text-ink-500">{label}</div>
      {children}
    </label>
  );
}
