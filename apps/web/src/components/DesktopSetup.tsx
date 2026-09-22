import { useState } from "react";
import { FolderOpen, CheckCircle2, ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import type { Settings } from "../types";

export function DesktopSetup({
  settings,
  onDone,
}: {
  settings: Settings;
  onDone(settings: Settings): void;
}) {
  const [form, setForm] = useState({
    workspaceRoot: settings.workspaceRoot,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    llmApiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [savedKey, setSavedKey] = useState(!!settings.llmApiKeyConfigured);
  const [connected, setConnected] = useState(false);
  async function save(test: boolean) {
    setBusy(true);
    setStatus("");
    setConnected(false);
    try {
      const host = new URL(form.llmBaseUrl).hostname;
      if (!form.llmApiKey.trim() && !savedKey && ["api.deepseek.com", "api.openai.com"].includes(host)) {
        throw new Error("请先填写此模型服务的 API Key，再测试连接或进入工作台。");
      }
      const next = await api.saveSettings({ ...form, runtime: "pig" });
      if (!next.workspaceExists) throw new Error("工作目录不存在，请选择已有文件夹。");
      setSavedKey(!!next.llmApiKeyConfigured);
      setForm((value) => ({ ...value, llmApiKey: "" }));
      if (test) {
        const response = await fetch("/api/settings/test-connection", {
          method: "POST",
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "模型连接失败");
        setStatus("连接成功，可以开始工作了。");
        setConnected(true);
      } else {
        localStorage.setItem("pig-agent.desktop-setup", "complete");
        onDone(next);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "配置失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-auto bg-ink-50 p-6">
      <main className="w-full max-w-xl rounded-2xl border border-ink-300 bg-panel p-8 shadow-panel">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-xl font-bold text-white">
            P
          </span>
          <span className="text-sm font-medium text-ink-600">
            Pig Agent · 桌面工作台
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-ink-900">
          让任务从这里开始
        </h1>
        <p className="mb-6 mt-2 text-sm leading-6 text-ink-500">
          选好工作目录，连接你的模型。会话保存在这台电脑，API Key
          使用系统加密存储。
        </p>
        <div className="space-y-4">
          <label className="block text-sm text-ink-700">
            工作目录
            <div className="mt-2 flex gap-2">
              <input
                className="field"
                value={form.workspaceRoot}
                onChange={(e) =>
                  setForm({ ...form, workspaceRoot: e.target.value })
                }
              />
              <button
                className="shrink-0 rounded-btn border border-ink-300 px-3"
                title="选择文件夹"
                onClick={async () => {
                  try {
                    const value = await window.pigDesktop?.chooseWorkspace();
                    if (value) setForm({ ...form, workspaceRoot: value });
                  } catch {
                    setStatus("无法打开文件夹选择器");
                  }
                }}
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </label>
          <label className="block text-sm text-ink-700">
            模型接口地址
            <input
              className="field mt-2"
              value={form.llmBaseUrl}
              onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm text-ink-700">
              模型名称
              <input
                className="field mt-2"
                value={form.llmModel}
                onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
              />
            </label>
            <label className="text-sm text-ink-700">
              API Key
              <input
                className="field mt-2"
                type="password"
                autoComplete="off"
                value={form.llmApiKey}
                placeholder="输入密钥；已保存则留空"
                onChange={(e) =>
                  setForm({ ...form, llmApiKey: e.target.value })
                }
              />
            </label>
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-ink-500">
          连接测试会发起一次简短的模型请求，按提供商规则计费。默认写入需要审阅；命令默认在原生沙箱中执行。
        </p>
        {status && (
          <div
            role="status"
            className={`mt-4 rounded-btn p-3 text-sm ${connected ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
          >
            {connected && <CheckCircle2 className="mr-2 inline" size={16} />}{" "}
            {status}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            disabled={busy}
            className="rounded-btn border border-ink-300 px-4 py-2 text-sm text-ink-700 disabled:opacity-50"
            onClick={() => void save(true)}
          >
            {busy ? "正在处理…" : "保存并测试连接"}
          </button>
          <button
            disabled={busy}
            className="flex items-center gap-2 rounded-btn bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void save(false)}
          >
            进入工作台
            <ArrowRight size={16} />
          </button>
        </div>
      </main>
    </div>
  );
}
