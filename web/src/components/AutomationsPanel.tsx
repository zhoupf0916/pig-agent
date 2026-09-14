import { Play, Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import type { Automation, Expert, ExpertTeam, ProjectSummary } from "../types";

export function AutomationsPanel({
  selectedId,
  experts,
  teams,
  projects,
  onSelect,
  onOpenSession,
}: {
  selectedId?: string;
  experts: Expert[];
  teams: ExpertTeam[];
  projects: ProjectSummary[];
  onSelect: (id?: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<Automation[]>([]);
  const [detail, setDetail] = useState<Automation | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    prompt: "",
    schedule: "",
    expertId: "",
    expertTeamId: "",
    projectId: "",
  });

  const refreshList = async () => {
    const { automations } = await api.automations();
    setItems(automations);
    return automations;
  };

  const loadDetail = async (id: string) => {
    const automation = await api.automation(id);
    setDetail(automation);
    setDraft({
      name: automation.name,
      prompt: automation.prompt,
      schedule: automation.schedule ?? "",
      expertId: automation.expertId ?? "",
      expertTeamId: automation.expertTeamId ?? "",
      projectId: automation.projectId ?? "",
    });
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        if (selectedId) await loadDetail(selectedId);
        else if (list[0]) onSelect(list[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  const expertName = useMemo(
    () => experts.find((e) => e.id === detail?.expertId)?.name,
    [experts, detail?.expertId],
  );
  const teamName = useMemo(
    () => teams.find((t) => t.id === detail?.expertTeamId)?.name,
    [teams, detail?.expertTeamId],
  );
  const projectName = useMemo(
    () => projects.find((p) => p.id === detail?.projectId)?.name,
    [projects, detail?.projectId],
  );

  const savePatch = async (patch: Parameters<typeof api.patchAutomation>[1]) => {
    if (!detail) return;
    const next = await api.patchAutomation(detail.id, patch);
    setDetail(next);
    await refreshList();
  };

  return (
    <section className="flex min-w-0 flex-1 overflow-hidden bg-ink-50">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-ink-300 bg-ink-100">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">自动化</div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">本机定时 / 手动</div>
          </div>
        </div>
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !prompt.trim()) return;
            void (async () => {
              try {
                const created = await api.createAutomation({
                  name: name.trim(),
                  prompt: prompt.trim(),
                  schedule: null,
                });
                setName("");
                setPrompt("");
                await refreshList();
                onSelect(created.id);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
        >
          <input
            className="field"
            placeholder="新自动化名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="field min-h-[64px] resize-y"
            placeholder="每次运行的提示词"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full" disabled={!name.trim() || !prompt.trim()}>
            <Plus size={14} />
            新建自动化
          </button>
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {items.map((item) => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`w-full rounded-card px-2.5 py-2 text-left ${
                  active ? "bg-accent-soft text-ink-800" : "text-ink-700 hover:bg-ink-200"
                }`}
              >
                <div className="truncate text-[13px] font-medium">{item.name}</div>
                <div className="mt-0.5 text-meta text-ink-500">
                  {item.enabled ? "已启用" : "已停用"}
                  {item.schedule ? ` · ${item.schedule}` : " · 仅手动"}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {!detail && (
          <div className="flex h-full flex-col items-center justify-center text-ink-500">
            <Workflow size={28} className="mb-3 text-ink-400" />
            <p className="text-sm">选择或新建一个本机自动化</p>
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">{detail.name}</h2>
                <p className="mt-1 text-xs text-ink-500">
                  本机 JSON · 默认 pig 运行时 · 无公网 webhook
                  {expertName ? ` · 专家 ${expertName}` : ""}
                  {teamName ? ` · 小队 ${teamName}` : ""}
                  {projectName ? ` · 项目 ${projectName}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={running}
                  onClick={() => {
                    void (async () => {
                      setRunning(true);
                      setError(null);
                      try {
                        const result = await api.runAutomation(detail.id);
                        setDetail(result.automation);
                        await refreshList();
                        onOpenSession(result.session.id);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setRunning(false);
                      }
                    })();
                  }}
                >
                  <Play size={14} />
                  {running ? "启动中…" : "立即运行"}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-danger hover:bg-danger-soft"
                  onClick={() => {
                    void (async () => {
                      await api.deleteAutomation(detail.id);
                      setDetail(null);
                      const list = await refreshList();
                      onSelect(list[0]?.id);
                    })();
                  }}
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={detail.enabled}
                onChange={(e) => void savePatch({ enabled: e.target.checked })}
              />
              启用（定时触发需要勾选；立即运行始终可用）
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">名称</span>
              <input
                className="field mt-1"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                onBlur={() => {
                  if (draft.name.trim() && draft.name.trim() !== detail.name) {
                    void savePatch({ name: draft.name.trim() });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">提示词</span>
              <textarea
                className="field mt-1 min-h-[160px] resize-y font-mono text-[12px]"
                value={draft.prompt}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                onBlur={() => {
                  if (draft.prompt.trim() && draft.prompt !== detail.prompt) {
                    void savePatch({ prompt: draft.prompt });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">计划</span>
              <input
                className="field mt-1 font-mono"
                placeholder="@daily / @hourly / 0 9 * * 1 / 留空=仅手动"
                value={draft.schedule}
                onChange={(e) => setDraft((d) => ({ ...d, schedule: e.target.value }))}
                onBlur={() => {
                  const next = draft.schedule.trim() || null;
                  if (next !== detail.schedule) void savePatch({ schedule: next });
                }}
              />
              <p className="mt-1 text-xs text-ink-500">
                五段 cron 或别名，按本机本地时区。进程内约 30 秒扫一次；同一自动化不会重叠跑。
              </p>
            </label>

            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-meta uppercase tracking-[0.16em] text-ink-500">专家</span>
                <select
                  className="field mt-1"
                  value={draft.expertId}
                  onChange={(e) => {
                    const expertId = e.target.value || null;
                    setDraft((d) => ({ ...d, expertId: e.target.value }));
                    void savePatch({ expertId });
                  }}
                >
                  <option value="">（不钉）</option>
                  {experts.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-meta uppercase tracking-[0.16em] text-ink-500">小队</span>
                <select
                  className="field mt-1"
                  value={draft.expertTeamId}
                  onChange={(e) => {
                    const expertTeamId = e.target.value || null;
                    setDraft((d) => ({ ...d, expertTeamId: e.target.value }));
                    void savePatch({ expertTeamId });
                  }}
                >
                  <option value="">（不钉）</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-meta uppercase tracking-[0.16em] text-ink-500">项目</span>
                <select
                  className="field mt-1"
                  value={draft.projectId}
                  onChange={(e) => {
                    const projectId = e.target.value || null;
                    setDraft((d) => ({ ...d, projectId: e.target.value }));
                    void savePatch({ projectId });
                  }}
                >
                  <option value="">（不钉）</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-start gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={Boolean(detail.saveArtifactsToProject)}
                disabled={!detail.projectId}
                onChange={(e) => void savePatch({ saveArtifactsToProject: e.target.checked })}
              />
              <span>
                运行成功后把新产物保存到项目资产
                <span className="mt-0.5 block text-xs text-ink-500">
                  默认关。需先钉选项目；同一工作区路径会覆盖已有资产。
                </span>
              </span>
            </label>

            <div className="rounded-card border border-ink-300 bg-panel px-3 py-3 text-xs text-ink-600">
              <div>运行时：{detail.runtime}（默认 pig，不改全局设置）</div>
              <div className="mt-1">
                上次运行：{detail.lastRunAt ? formatTime(detail.lastRunAt) : "尚未运行"}
              </div>
              {detail.lastSessionId && (
                <button
                  type="button"
                  className="btn-ghost mt-2"
                  onClick={() => onOpenSession(detail.lastSessionId!)}
                >
                  打开上次会话
                </button>
              )}
              {detail.lastError && <div className="mt-2 text-danger">{detail.lastError}</div>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
