import { SkillsLibrary } from "./SkillsLibrary";
import { SkillSelection } from "./SkillComposerInput";
import { ResourceCreator } from "./ResourceCreator";
import { useDialog } from "../lib/use-dialog";
import { Sparkles, Trash2, Users, ArrowUpRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  applyExpertDetailSnapshot,
  applyExpertTeamsListSnapshot,
  applyExpertsListSnapshot,
  canDeleteExpertTeam,
  formatExpertTeamMemberLabel,
  nextOpenExpertId,
  shouldFetchExpertDetail,
  startExpertsSync,
} from "../lib/experts-sync";
import type { Expert, ExpertKind, ExpertTeam, SkillMeta } from "../types";

const KIND_LABEL: Record<ExpertKind, string> = {
  scout: "侦察",
  plan: "规划",
  implement: "实现",
  review: "评审",
  custom: "自定义",
};

export function ExpertsPanel({
  selectedId,
  skills,
  onUseSkill,
  onRefreshSkills,
  onSelectExpert,
  onPinExpert,
  onPinTeam,
}: {
  selectedId?: string;
  skills: SkillMeta[];
  onUseSkill: (id: string) => void;
  onRefreshSkills: () => void;
  onSelectExpert: (id?: string) => void;
  onPinExpert: (expertId: string) => void;
  onPinTeam: (teamId: string) => void;
}) {
  const [libraryKind, setLibraryKind] = useState<"expert" | "skill">("expert");
  const [bindingBusy, setBindingBusy] = useState(false);
  const draftBaseline = useRef({ id: "", value: "" });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const catalogDialog = useDialog(catalogOpen, () => setCatalogOpen(false));
  useEffect(() => {
    if (selectedId) setCatalogOpen(false);
  }, [selectedId]);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [teams, setTeams] = useState<ExpertTeam[]>([]);
  const [detail, setDetail] = useState<Expert | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftInstruction, setDraftInstruction] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftName, setDraftName] = useState("");

  const refreshList = async () => {
    const [{ experts: next }, { teams: nextTeams }] = await Promise.all([
      api.experts(),
      api.expertTeams(),
    ]);
    setExperts(next);
    setTeams(nextTeams);
    return next;
  };

  const loadDetail = async (id: string) => {
    const expert = await api.expert(id);
    setDetail(expert);
    setDraftName(expert.name);
    setDraftDescription(expert.description);
    setDraftInstruction(expert.instruction);
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        // AN-02 nail: list absence first — rewrite hash / open state, never GET :id
        if (selectedId && !shouldFetchExpertDetail(selectedId, list)) {
          const nextId = nextOpenExpertId(selectedId, list);
          onSelectExpert(nextId ?? undefined);
          setDetail(null);
          return;
        }
        if (selectedId) await loadDetail(selectedId);
        else setDetail(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  useEffect(() => {
    return startExpertsSync({
      fetchList: async () => {
        const { experts: next } = await api.experts();
        return next;
      },
      onList: (next) =>
        setExperts((prev) => applyExpertsListSnapshot(prev, next)),
      fetchTeams: async () => {
        const { teams: next } = await api.expertTeams();
        return next;
      },
      onTeams: (next) =>
        setTeams((prev) => applyExpertTeamsListSnapshot(prev, next)),
      selectedId,
      fetchSelected: selectedId ? (id) => api.expert(id) : undefined,
      onSelected: (next) =>
        setDetail((prev) => applyExpertDetailSnapshot(prev, next)),
      onOpenId: (nextId) => {
        onSelectExpert(nextId ?? undefined);
        setDetail(null);
      },
    });
  }, [selectedId]);

  useEffect(() => {
    if (!detail) return;
    const incoming = JSON.stringify([
      detail.name,
      detail.description,
      detail.instruction,
    ]);
    const current = JSON.stringify([
      draftName,
      draftDescription,
      draftInstruction,
    ]);
    if (
      draftBaseline.current.id === detail.id &&
      current !== draftBaseline.current.value &&
      current !== incoming
    )
      return;
    draftBaseline.current = { id: detail.id, value: incoming };
    setDraftName(detail.name);
    setDraftDescription(detail.description);
    setDraftInstruction(detail.instruction);
  }, [detail]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.expertIds.includes(detail?.id ?? "")),
    [teams, detail?.id],
  );

  const tabs = <div className="cloud-tabs" role="tablist" aria-label="专家与技能"><button type="button" role="tab" aria-selected={libraryKind === "expert"} onClick={() => setLibraryKind("expert")}>专家</button><button type="button" role="tab" aria-selected={libraryKind === "skill"} onClick={() => setLibraryKind("skill")}>技能</button></div>;
  if (libraryKind === "skill") return <section className="resource-page"><header className="resource-header"><h2>专家与技能</h2></header>{tabs}<SkillsLibrary skills={skills} onUse={onUseSkill} onRefresh={onRefreshSkills}/></section>;
  return (
    <section className="resource-page" aria-label="专家">
      <header className="resource-header">
        <div>
          <h2>专家</h2>
          <p>复用本机工作方法与任务指令</p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setCatalogOpen(true)}
          aria-expanded={catalogOpen}
        >
          专家目录 <span>{experts.length}</span>
        </button>
      </header>
      {tabs}
      {catalogOpen && (
        <button
          className="resource-scrim"
          aria-label="关闭专家目录"
          onClick={() => setCatalogOpen(false)}
        />
      )}
      <div
        ref={catalogDialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="专家目录"
        hidden={!catalogOpen}
        className="resource-catalog"
      >
        <div className="resource-catalog-heading">
          <h3>专家目录</h3>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setCatalogOpen(false)}
          >
            关闭
          </button>
        </div>
        <input
          className="field resource-catalog-search"
          aria-label="搜索专家"
          placeholder="搜索专家"
          value={catalogQuery}
          onChange={(e) => setCatalogQuery(e.target.value)}
        />

        {catalogQuery &&
          !experts.some((row) =>
            row.name
              .toLocaleLowerCase()
              .includes(catalogQuery.toLocaleLowerCase()),
          ) && (
            <p role="status" className="resource-catalog-empty">
              没有匹配的专家
            </p>
          )}
        <div className="resource-catalog-intro">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
              专家
            </div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">
              工作方法与技能
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="resource-error">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {experts
            .filter((row) =>
              row.name
                .toLocaleLowerCase()
                .includes(catalogQuery.toLocaleLowerCase()),
            )
            .map((expert) => {
              const active = expert.id === selectedId;
              return (
                <button
                  key={expert.id}
                  type="button"
                  onClick={() => {
                    setCatalogOpen(false);
                    onSelectExpert(expert.id);
                  }}
                  className={`w-full rounded-card px-2.5 py-2 text-left ${
                    active
                      ? "bg-accent-soft text-ink-800"
                      : "text-ink-700 hover:bg-ink-200"
                  }`}
                >
                  <div className="truncate text-[13px] font-medium">
                    {expert.name}
                  </div>
                  <div className="mt-0.5 text-meta text-ink-500">
                    {KIND_LABEL[expert.kind]}
                    {expert.bundled ? " · 内置" : ""}
                    {expert.skillIds.length
                      ? ` · ${expert.skillIds.join(", ")}`
                      : ""}
                  </div>
                </button>
              );
            })}
          {teams.length > 0 && (
            <div className="px-2 pb-1 pt-4 text-meta uppercase tracking-[0.16em] text-ink-500">
              小队
            </div>
          )}
          {teams.map((team) => (
            <div
              key={team.id}
              className="rounded-card border border-ink-300 bg-panel px-2.5 py-2 text-left"
            >
              <div className="truncate text-[13px] font-medium text-ink-800">
                {team.name}
              </div>
              <div className="mt-0.5 text-meta text-ink-500">
                {team.mode === "chain"
                  ? "接力（同会话顺序执行）"
                  : "并行（仍为一条拼接指令）"}{" "}
                · {formatExpertTeamMemberLabel(team.expertIds)}
                {team.bundled ? " · 内置" : ""}
              </div>
              <button
                type="button"
                className="btn-ghost mt-2 w-full"
                onClick={() => onPinTeam(team.id)}
              >
                绑定到当前会话
              </button>
              {canDeleteExpertTeam(team) && (
                <button
                  type="button"
                  className="btn-ghost mt-1 w-full text-danger hover:bg-danger-soft"
                  onClick={() => {
                    void (async () => {
                      await api.deleteExpertTeam(team.id);
                      await refreshList();
                    })();
                  }}
                >
                  <Trash2 size={14} />
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="resource-content">
        <ResourceCreator
          kind="expert"
          onCreated={(id) => {
            void refreshList();
            onSelectExpert(id);
          }}
        />
        {error && (
          <p role="alert" className="resource-error">
            {error}
          </p>
        )}
        {!detail && (
          <div className="desktop-library">
            <div className="desktop-library-toolbar">
              <h3>选择一位专家开始</h3>
              <label>
                <Search size={16} />
                <input
                  className="field"
                  aria-label="筛选专家"
                  placeholder="搜索名称或用途"
                  value={catalogQuery}
                  onChange={(e) => setCatalogQuery(e.target.value)}
                />
              </label>
            </div>
            <div className="desktop-library-grid">
              {experts
                .filter((row) =>
                  `${row.name} ${row.description}`
                    .toLowerCase()
                    .includes(catalogQuery.toLowerCase()),
                )
                .map((expert) => (
                  <article key={expert.id}>
                    <div className="desktop-library-avatar">
                      <Users size={23} />
                    </div>
                    <h3>{expert.name}</h3>
                    <span className="desktop-library-tag">
                      {KIND_LABEL[expert.kind]}
                      {expert.bundled ? " · 内置" : ""}
                    </span>
                    <p>
                      {expert.description || "复用这个专家的工作方法与技能"}
                    </p>
                    <div className="desktop-library-actions">
                      <button
                        className="btn-primary"
                        onClick={() => onPinExpert(expert.id)}
                      >
                        用于当前任务 <ArrowUpRight size={14} />
                      </button>
                      <button
                        className="btn-quiet"
                        onClick={() => onSelectExpert(expert.id)}
                      >
                        查看详情
                      </button>
                    </div>
                  </article>
                ))}
            </div>
            {!experts.some((row) =>
              `${row.name} ${row.description}`
                .toLowerCase()
                .includes(catalogQuery.toLowerCase()),
            ) && (
              <p className="desktop-library-empty">
                没有匹配的专家。换个关键词，或创建你的专属专家。
              </p>
            )}
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <button
              className="btn-quiet self-start"
              onClick={() => onSelectExpert(undefined)}
            >
              ← 返回专家列表
            </button>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">
                  {detail.name}
                </h2>
                <p className="mt-1 text-xs text-ink-500">
                  绑定到任务后使用这套指令与技能
                  {selectedTeam ? ` · 也属于「${selectedTeam.name}」` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onPinExpert(detail.id)}
                >
                  绑定到当前会话
                </button>
                {!detail.bundled && (
                  <button
                    type="button"
                    className="btn-ghost text-danger hover:bg-danger-soft"
                    onClick={() => {
                      void (async () => {
                        await api.deleteExpert(detail.id);
                        setDetail(null);
                        const list = await refreshList();
                        onSelectExpert(list[0]?.id);
                      })();
                    }}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                )}
              </div>
            </div>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                名称
              </span>
              <input
                className="field mt-1"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => {
                  if (draftName.trim() && draftName.trim() !== detail.name) {
                    void api
                      .patchExpert(detail.id, { name: draftName.trim() })
                      .then((next) => {
                        setDetail(next);
                        void refreshList();
                      });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                简介
              </span>
              <input
                className="field mt-1"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                onBlur={() => {
                  if (draftDescription !== detail.description) {
                    void api
                      .patchExpert(detail.id, { description: draftDescription })
                      .then((next) => {
                        setDetail(next);
                        void refreshList();
                      });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                指令
              </span>
              <textarea
                className="field mt-1 min-h-[220px] resize-y font-mono text-[12px]"
                value={draftInstruction}
                onChange={(e) => setDraftInstruction(e.target.value)}
                onBlur={() => {
                  if (draftInstruction !== detail.instruction) {
                    void api
                      .patchExpert(detail.id, { instruction: draftInstruction })
                      .then((next) => {
                        setDetail(next);
                      });
                  }
                }}
              />
            </label>

            <div>
              <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
                引用技能
              </div>
              <p className="mt-1 text-xs text-ink-500">
                可使用内置、本机创建或已启用插件提供的技能。实现专家默认带{" "}
                <code>coding-helper</code>。
              </p>
              <SkillSelection skills={skills.map(s => ({ id: s.name, name: s.displayName || s.name, description: s.description }))} value={detail.skillIds} disabled={detail.bundled || bindingBusy} onChange={ids => {
                setBindingBusy(true); setError(null);
                void api.patchExpert(detail.id, { skillIds: ids }).then(next => { setDetail(next); void refreshList(); }).catch(e => setError(String(e))).finally(() => setBindingBusy(false));
              }} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
