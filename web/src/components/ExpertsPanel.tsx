import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
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
  onSelectExpert,
  onPinExpert,
  onPinTeam,
}: {
  selectedId?: string;
  skills: SkillMeta[];
  onSelectExpert: (id?: string) => void;
  onPinExpert: (expertId: string) => void;
  onPinTeam: (teamId: string) => void;
}) {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [teams, setTeams] = useState<ExpertTeam[]>([]);
  const [detail, setDetail] = useState<Expert | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
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
        if (selectedId) await loadDetail(selectedId);
        else if (list[0]) onSelectExpert(list[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.expertIds.includes(detail?.id ?? "")),
    [teams, detail?.id],
  );

  return (
    <section className="flex min-w-0 flex-1 overflow-hidden bg-ink-50">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-ink-300 bg-ink-100">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">专家</div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">本机 Playbook</div>
          </div>
        </div>
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !instruction.trim()) return;
            void (async () => {
              const created = await api.createExpert({
                name: name.trim(),
                instruction: instruction.trim(),
                kind: "custom",
              });
              setName("");
              setInstruction("");
              await refreshList();
              onSelectExpert(created.id);
            })();
          }}
        >
          <input
            className="field"
            placeholder="新专家名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="field min-h-[64px] resize-y"
            placeholder="指令（会注入系统提示）"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full" disabled={!name.trim() || !instruction.trim()}>
            <Plus size={14} />
            新建专家
          </button>
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {experts.map((expert) => {
            const active = expert.id === selectedId;
            return (
              <button
                key={expert.id}
                type="button"
                onClick={() => onSelectExpert(expert.id)}
                className={`w-full rounded-card px-2.5 py-2 text-left ${
                  active ? "bg-accent-soft text-ink-800" : "text-ink-700 hover:bg-ink-200"
                }`}
              >
                <div className="truncate text-[13px] font-medium">{expert.name}</div>
                <div className="mt-0.5 text-meta text-ink-500">
                  {KIND_LABEL[expert.kind]}
                  {expert.bundled ? " · 内置" : ""}
                  {expert.skillIds.length ? ` · ${expert.skillIds.join(", ")}` : ""}
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
              className="rounded-card border border-ink-300 bg-white px-2.5 py-2 text-left"
            >
              <div className="truncate text-[13px] font-medium text-ink-800">{team.name}</div>
              <div className="mt-0.5 text-meta text-ink-500">
                {team.mode === "chain" ? "接力" : "并行"} · {team.expertIds.length} 人
                {team.bundled ? " · 内置" : ""}
              </div>
              <button
                type="button"
                className="btn-ghost mt-2 w-full"
                onClick={() => onPinTeam(team.id)}
              >
                绑定到当前会话
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {!detail && (
          <div className="flex h-full flex-col items-center justify-center text-ink-500">
            <Sparkles size={28} className="mb-3 text-ink-400" />
            <p className="text-sm">选择或新建一个本机专家</p>
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">{detail.name}</h2>
                <p className="mt-1 text-xs text-ink-500">
                  本机 JSON playbook · 指令先于项目指令注入 pig / Codex / cloud-stub
                  {selectedTeam ? ` · 也属于「${selectedTeam.name}」` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary" onClick={() => onPinExpert(detail.id)}>
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
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">名称</span>
              <input
                className="field mt-1"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => {
                  if (draftName.trim() && draftName.trim() !== detail.name) {
                    void api.patchExpert(detail.id, { name: draftName.trim() }).then((next) => {
                      setDetail(next);
                      void refreshList();
                    });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">简介</span>
              <input
                className="field mt-1"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                onBlur={() => {
                  if (draftDescription !== detail.description) {
                    void api.patchExpert(detail.id, { description: draftDescription }).then((next) => {
                      setDetail(next);
                      void refreshList();
                    });
                  }
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">指令</span>
              <textarea
                className="field mt-1 min-h-[220px] resize-y font-mono text-[12px]"
                value={draftInstruction}
                onChange={(e) => setDraftInstruction(e.target.value)}
                onBlur={() => {
                  if (draftInstruction !== detail.instruction) {
                    void api.patchExpert(detail.id, { instruction: draftInstruction }).then((next) => {
                      setDetail(next);
                    });
                  }
                }}
              />
            </label>

            <div>
              <div className="text-meta uppercase tracking-[0.16em] text-ink-500">引用技能</div>
              <p className="mt-1 text-xs text-ink-500">
                只引用仓库 <code>skills/</code>，不是插件市场。实现专家默认带 <code>coding-helper</code>。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(detail.skillIds.length ? detail.skillIds : ["（无）"]).map((id) => (
                  <span
                    key={id}
                    className="rounded-full border border-ink-300 bg-white px-2 py-0.5 text-meta text-ink-600"
                  >
                    {id}
                  </span>
                ))}
                {skills
                  .filter((s) => !detail.skillIds.includes(s.name))
                  .slice(0, 4)
                  .map((s) => (
                    <span key={s.name} className="text-meta text-ink-400">
                      {s.name}
                    </span>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
