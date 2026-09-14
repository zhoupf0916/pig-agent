import { useEffect, useState } from "react";
import type { Settings, SkillMeta } from "../types";

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
  const [form, setForm] = useState<Settings>({
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    workspaceRoot: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && settings) setForm(settings);
    setError(null);
  }, [open, settings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-ink-900 p-5 shadow-panel">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-medium text-white">设置</h2>
            <p className="mt-1 text-xs text-ink-500">
              全部保存在本机 data/settings.json。默认对接 Ollama 的 OpenAI 兼容接口。
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-ink-500 hover:text-white">
            关闭
          </button>
        </div>

        <div className="space-y-3">
          <Field label="LLM Base URL">
            <input
              value={form.llmBaseUrl}
              onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
              className="field"
              placeholder="http://127.0.0.1:11434/v1"
            />
          </Field>
          <Field label="API Key（Ollama 可填 ollama 或留空）">
            <input
              type="password"
              value={form.llmApiKey}
              onChange={(e) => setForm({ ...form, llmApiKey: e.target.value })}
              className="field"
              placeholder="ollama"
            />
          </Field>
          <Field label="模型">
            <input
              value={form.llmModel}
              onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
              className="field"
              placeholder="llama3.2"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] text-ink-500">{label}</div>
      {children}
    </label>
  );
}
