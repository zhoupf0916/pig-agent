import { SkillSelection, type SkillChoice } from "./SkillComposerInput";
import { useDialog } from "../lib/use-dialog";
import { Play, Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  applyAutomationDetailSnapshot,
  applyAutomationsListSnapshot,
  automationLastErrorLabel,
  automationLastRunLabel,
  automationLastSessionLabel,
  nextOpenAutomationId,
  shouldFetchAutomationDetail,
  startAutomationsListSync,
} from "../lib/automations-list-sync";
import type { Automation, Expert, ExpertTeam, ProjectSummary, SkillMeta } from "../types";

export function AutomationsPanel({
  selectedId,
  skills,
  experts,
  teams,
  projects,
  onSelect,
  onOpenSession,
  onOpenRemoteRun,
}: {
  selectedId?: string;
  skills: SkillMeta[];
  experts: Expert[];
  teams: ExpertTeam[];
  projects: ProjectSummary[];
  onSelect: (id?: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRemoteRun: (id: string) => void;
}) {
  const draftBaseline = useRef({ id: "", value: "" });
  const createKey = useRef({ body: "", key: crypto.randomUUID() });
  const runKey = useRef({ id: "", key: crypto.randomUUID() });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const catalogDialog = useDialog(catalogOpen, () => setCatalogOpen(false));
  useEffect(() => { if (selectedId) setCatalogOpen(false); }, [selectedId]);
  const [items, setItems] = useState<Automation[]>([]);
  const [detail, setDetail] = useState<Automation | null>(null);
  const [remoteSkills, setRemoteSkills] = useState<SkillChoice[]>([]);
  const [createSkillIds, setCreateSkillIds] = useState<string[]>([]);
  const [target, setTarget] = useState<"local" | "remote">("local");
  const [creating, setCreating] = useState(false);
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
    skillIds: [] as string[],
  });

  useEffect(() => {
    if (target !== "remote" && detail?.executionTarget !== "remote") return;
    let valid = true;
    void fetch("/api/remote/v1/skills").then(async response => { const result = await response.json(); if (!response.ok) throw Error(result.error); if (valid) setRemoteSkills(result.skills.map((s: SkillChoice & { displayName?: string }) => ({ ...s, name: s.displayName || s.name }))); }).catch(e => { if (valid) setError(`远端技能暂不可用：${String(e)}`); });
    return () => { valid = false; };
  }, [target, detail?.executionTarget]);
  const localChoices = skills.map(s => ({ id: s.name, name: s.displayName || s.name, description: s.description }));

  const refreshList = async () => {
    const { automations, remoteError } = await api.automations();
    if (remoteError) {
      setItems((prev) => [
        ...automations,
        ...prev.filter((a) => a.executionTarget === "remote"),
      ]);
      throw Error(remoteError);
    }
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
      skillIds: automation.skillIds || [],
    });
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        // AN-02 nail: list absence first — rewrite hash / open state, never GET :id
        if (selectedId && !shouldFetchAutomationDetail(selectedId, list)) {
          const nextId = nextOpenAutomationId(selectedId, list);
          onSelect(nextId ?? undefined);
          setDetail(null);
          return;
        }
        if (selectedId) await loadDetail(selectedId);
        else if (list[0]) onSelect(list[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  useEffect(() => {
    return startAutomationsListSync({
      fetchList: async () => {
        const { automations, remoteError } = await api.automations();
        if (remoteError) throw Error(remoteError);
        return automations;
      },
      onList: (next) =>
        setItems((prev) => applyAutomationsListSnapshot(prev, next)),
      selectedId,
      fetchSelected: selectedId ? (id) => api.automation(id) : undefined,
      onSelected: (next) =>
        setDetail((prev) => applyAutomationDetailSnapshot(prev, next)),
      onOpenId: (nextId) => {
        onSelect(nextId ?? undefined);
        setDetail(null);
      },
    });
  }, [selectedId]);

  useEffect(() => {
    if (!detail) return;
    const incoming = JSON.stringify({ name: detail.name, prompt: detail.prompt, schedule: detail.schedule ?? "", expertId: detail.expertId ?? "", expertTeamId: detail.expertTeamId ?? "", projectId: detail.projectId ?? "", skillIds: detail.skillIds || [] });
    if (draftBaseline.current.id === detail.id && JSON.stringify(draft) !== draftBaseline.current.value && JSON.stringify(draft) !== incoming) return;
    draftBaseline.current = { id: detail.id, value: incoming };
    setDraft({
      name: detail.name,
      prompt: detail.prompt,
      schedule: detail.schedule ?? "",
      expertId: detail.expertId ?? "",
      expertTeamId: detail.expertTeamId ?? "",
      projectId: detail.projectId ?? "",
      skillIds: detail.skillIds || [],
    });
  }, [
    detail?.id,
    detail?.name,
    detail?.prompt,
    detail?.schedule,
    detail?.expertId,
    detail?.expertTeamId,
    detail?.projectId,
    detail?.skillIds,
  ]);

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

  const savePatch = async (
    patch: Parameters<typeof api.patchAutomation>[1],
  ) => {
    if (!detail) return;
    try {
      const next = await api.patchAutomation(detail.id, patch);
      setDetail(next);
      setError(null);
      await refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="resource-page" aria-label="自动化">
      <header className="resource-header"><div><h2>自动化</h2><p>安排重复任务，追踪每一次运行</p></div><button type="button" className="btn-primary" onClick={() => setCatalogOpen(true)} aria-expanded={catalogOpen}>自动化目录 <span>{items.length}</span></button></header>
      {catalogOpen && <button className="resource-scrim" aria-label="关闭自动化目录" onClick={() => setCatalogOpen(false)} />}
      <div ref={catalogDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="自动化目录" hidden={!catalogOpen} className="resource-catalog">
        <div className="resource-catalog-heading"><h3>自动化目录</h3><button type="button" className="btn-quiet" onClick={() => setCatalogOpen(false)}>关闭</button></div>
        <input className="field resource-catalog-search" aria-label="搜索自动化" placeholder="搜索自动化" value={catalogQuery} onChange={e => setCatalogQuery(e.target.value)} />

        {catalogQuery && !items.some(row => row.name.toLocaleLowerCase().includes(catalogQuery.toLocaleLowerCase())) && <p role="status" className="resource-catalog-empty">没有匹配的自动化</p>}
        <div className="resource-catalog-intro">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
              自动化
            </div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">
              本地 / 远端定时
            </div>
          </div>
        </div>
        {error && <p role="alert" className="resource-error">{error}</p>}
        <form
          className="resource-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (creating || !name.trim() || !prompt.trim()) return;
            setCreating(true);
            void (async () => {
              try {
                const input = {
                  name: name.trim(),
                  prompt: prompt.trim(),
                  schedule: null,
                  executionTarget: target,
                  skillIds: createSkillIds,
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                };
                const signature = JSON.stringify(input);
                if (createKey.current.body !== signature)
                  createKey.current = {
                    body: signature,
                    key: crypto.randomUUID(),
                  };
                const created = await api.createAutomation(
                  input,
                  createKey.current.key,
                );
                createKey.current = { body: "", key: crypto.randomUUID() };
                setError(null);
                setName("");
                setPrompt("");
                setCreateSkillIds([]);
                await refreshList();
                onSelect(created.id);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setCreating(false);
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
          <select
            aria-label="自动化执行位置"
            className="field"
            value={target}
            onChange={(e) => (setTarget(e.target.value as "local" | "remote"), setCreateSkillIds([]))}
          >
            <option value="local">本地执行</option>
            <option value="remote">远端容器 · 控制面调度</option>
          </select>
          <SkillSelection skills={target === "remote" ? remoteSkills : localChoices} value={createSkillIds} onChange={setCreateSkillIds} disabled={creating} />
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={creating || !name.trim() || !prompt.trim()}
          >
            <Plus size={14} />
            新建自动化
          </button>
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {items.filter(row => row.name.toLocaleLowerCase().includes(catalogQuery.toLocaleLowerCase())).map((item) => {
            const active = item.id === selectedId;
            const listError = automationLastErrorLabel(item.lastError);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => { setCatalogOpen(false); onSelect(item.id); }}
                className={`w-full rounded-card px-2.5 py-2 text-left ${
                  active
                    ? "bg-accent-soft text-ink-800"
                    : "text-ink-700 hover:bg-ink-200"
                }`}
              >
                <div className="truncate text-[13px] font-medium">
                  {item.name}
                </div>
                <div className="mt-0.5 text-meta text-ink-500">
                  {item.executionTarget === "remote"
                    ? "远端 · "
                    : item.runtime === "cloud"
                      ? "待迁移 · "
                      : "本地 · "}
                  {item.enabled ? "已启用" : "已停用"}
                  {item.schedule ? ` · ${item.schedule}` : " · 仅手动"}
                </div>
                <div className="mt-0.5 truncate text-meta text-ink-500">
                  {automationLastRunLabel(item.lastRunAt)}
                </div>
                {automationLastSessionLabel(item.lastSessionId) && (
                  <div className="mt-0.5 truncate text-meta text-ink-500">
                    {automationLastSessionLabel(item.lastSessionId)}
                  </div>
                )}
                {listError && (
                  <div className="mt-0.5 truncate text-meta text-danger">
                    {listError}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="resource-content">
        {error && <p role="alert" className="resource-error">{error}</p>}
        {!detail && (
          <div className="resource-empty">
            <Workflow size={28} className="mb-3 text-ink-400" />
            <p className="text-sm">选择或新建一个自动化</p>
          <button type="button" className="btn-primary" onClick={() => setCatalogOpen(true)}>新建自动化</button>
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">
                  {detail.name}
                </h2>
                <p className="mt-1 text-xs text-ink-500">
                  {detail.executionTarget === "remote"
                    ? "控制面持久调度 · 退出客户端仍执行 · Pig"
                    : "本地调度 · 需要本地服务在线"}
                  {expertName ? ` · 专家 ${expertName}` : ""}
                  {teamName ? ` · 小队 ${teamName}` : ""}
                  {projectName ? ` · 项目 ${projectName}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={
                    running ||
                    (detail.runtime === "cloud" &&
                      detail.executionTarget !== "remote")
                  }
                  onClick={() => {
                    void (async () => {
                      setRunning(true);
                      setError(null);
                      try {
                        if (runKey.current.id !== detail.id)
                          runKey.current = {
                            id: detail.id,
                            key: crypto.randomUUID(),
                          };
                        const result = await api.runAutomation(
                          detail.id,
                          runKey.current.key,
                        );
                        runKey.current = { id: "", key: crypto.randomUUID() };
                        if (result.automation) setDetail(result.automation);
                        await refreshList();
                        if (result.session) onOpenSession(result.session.id);
                        if (result.remoteRunId)
                          onOpenRemoteRun(result.remoteRunId);
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : String(err),
                        );
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
                      try {
                        await api.deleteAutomation(detail.id);
                        setDetail(null);
                        const list = await refreshList();
                        onSelect(list[0]?.id);
                      } catch (e) {
                        setError(String(e));
                      }
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
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                名称
              </span>
              <input
                className="field mt-1"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                onBlur={() => {
                  if (draft.name.trim() && draft.name.trim() !== detail.name) {
                    void savePatch({ name: draft.name.trim() });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                提示词
              </span>
              <textarea
                className="field mt-1 min-h-[160px] resize-y font-mono text-[12px]"
                value={draft.prompt}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, prompt: e.target.value }))
                }
                onBlur={() => {
                  if (draft.prompt.trim() && draft.prompt !== detail.prompt) {
                    void savePatch({ prompt: draft.prompt });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                计划
              </span>
              <input
                className="field mt-1 font-mono"
                placeholder="@daily / @hourly / 0 9 * * 1 / 留空=仅手动"
                value={draft.schedule}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, schedule: e.target.value }))
                }
                onBlur={() => {
                  const next = draft.schedule.trim() || null;
                  if (next !== detail.schedule)
                    void savePatch({ schedule: next });
                }}
              />
              <p className="mt-1 text-xs text-ink-500">
                {detail.executionTarget === "remote"
                  ? "五段 cron 或别名，按所选时区；日期与星期不可同时限定。同一计划不重叠，超配额时跳过并记录原因。"
                  : "五段 cron 或别名，按本机时区。本地服务需在线；同一自动化不会重叠跑。"}
              </p>
            </label>

            {detail.executionTarget === "remote" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  时区
                  <input
                    key={detail.id + detail.timezone}
                    defaultValue={detail.timezone || "Asia/Shanghai"}
                    className="field mt-1"
                    onBlur={(e) => {
                      if (e.target.value !== detail.timezone)
                        void savePatch({ timezone: e.target.value });
                    }}
                  />
                </label>
                <label className="text-sm">
                  错过触发
                  <select
                    className="field mt-1"
                    value={detail.misfirePolicy || "skip"}
                    onChange={(e) =>
                      void savePatch({
                        misfirePolicy: e.target.value as "skip" | "once",
                      })
                    }
                  >
                    <option value="skip">跳过（迟到超过一分钟）</option>
                    <option value="once">恢复后补跑一次</option>
                  </select>
                </label>
                <p className="text-xs text-ink-500">
                  下次触发：
                  {detail.nextFireAt
                    ? new Date(detail.nextFireAt).toLocaleString()
                    : "无（已停用或仅手动）"}
                </p>
              </div>
            )}
            {detail.runtime === "cloud" &&
              detail.executionTarget !== "remote" && (
                <div className="rounded-card border border-warning p-3 text-sm">
                  此旧计划需要迁入控制面，本地已停止定时触发。
                  <button
                    className="btn-ghost ml-2"
                    onClick={async () => {
                      try {
                        const r = await fetch(
                          `/api/automations/${detail.id}/migrate`,
                          { method: "POST" },
                        );
                        const data = await r.json();
                        if (!r.ok) throw Error(data.error);
                        await refreshList();
                        onSelect(data.id);
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    迁入控制面
                  </button>
                </div>
              )}
            <SkillSelection skills={detail.executionTarget === "remote" ? remoteSkills : localChoices} value={draft.skillIds} onChange={skillIds => { setDraft(d => ({ ...d, skillIds })); void savePatch({ skillIds }); }} />
            {detail.executionTarget !== "remote" && (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                      专家
                    </span>
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
                    <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                      小队
                    </span>
                    <select
                      className="field mt-1"
                      value={draft.expertTeamId}
                      onChange={(e) => {
                        const expertTeamId = e.target.value || null;
                        setDraft((d) => ({
                          ...d,
                          expertTeamId: e.target.value,
                        }));
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
                    <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                      项目
                    </span>
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
                    onChange={(e) =>
                      void savePatch({
                        saveArtifactsToProject: e.target.checked,
                      })
                    }
                  />
                  <span>
                    运行成功后把新产物保存到项目资产
                    <span className="mt-0.5 block text-xs text-ink-500">
                      默认关。需先钉选项目；同一工作区路径会覆盖已有资产。
                    </span>
                  </span>
                </label>
              </>
            )}
            <div className="rounded-card border border-ink-300 bg-panel px-3 py-3 text-xs text-ink-600">
              {detail.lastRemoteRunId && (
                <button
                  className="btn-ghost"
                  onClick={() => onOpenRemoteRun(detail.lastRemoteRunId!)}
                >
                  查看上次远端运行与成果
                </button>
              )}
              <div>执行：{detail.executionTarget === "remote" ? "远端容器 · Pig" : `本地 · ${detail.runtime}`}（计划独立配置）</div>
              <div className="mt-1">
                {automationLastRunLabel(detail.lastRunAt)}
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
              {detail.lastError ? (
                <div className="mt-2 text-danger">
                  {automationLastErrorLabel(detail.lastError)}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
