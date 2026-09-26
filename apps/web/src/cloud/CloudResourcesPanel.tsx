import { SkillPackFiles, SkillPackImporter } from "../components/SkillPackView";
import type { SkillPackFile } from "@pig-agent/contracts";
import { useEffect, useState, useRef } from "react";
import {
  Search,
  Plus,
  Sparkles,
  BookOpen,
  Users,
  X,
  ArrowUpRight,
} from "lucide-react";
import { useDialog } from "../lib/use-dialog";
import { cloudRequest as api } from "./cloud-api";
type Resource = {
  id: string;
  name: string;
  description: string;
  instruction?: string;
  body?: string;
  bundled?: boolean;
  skillIds?: string[];
  displayName?: string;
  files?: SkillPackFile[];
};
export function CloudResourcesPanel({
  onNewTask,
  initialKind = "expert",
}: {
  onNewTask: (options: { expertId?: string; skillIds?: string[] }) => void;
  initialKind?: "expert" | "skill";
}) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [preview, setPreview] = useState<Resource | null>(null),
    [creating, setCreating] = useState(false),
    [kind, setKind] = useState<"expert" | "skill">(initialKind),
    [items, setItems] = useState<Resource[]>([]),
    [skills, setSkills] = useState<Resource[]>([]),
    [edit, setEdit] = useState<Partial<Resource> | null>(null),
    [prompt, setPrompt] = useState(""),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const close = () => {
    if (!busy) {
      setEdit(null);
      setPreview(null);
      setCreating(false);
    }
  };
  const dialog = useDialog<HTMLDivElement>(
    !!edit || !!preview || creating,
    close,
  );
  const revision = useRef(0);
  async function refresh() {
    const own = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const [experts, sk] = await Promise.all([
        api("/v1/experts"),
        api("/v1/skills"),
      ]);
      if (own === revision.current) {
        setItems(kind === "expert" ? experts.experts : sk.skills);
        setSkills(sk.skills);
      }
    } catch (e) {
      if (own === revision.current) setError(String(e));
    } finally {
      if (own === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    setKind(initialKind);
  }, [initialKind]);
  useEffect(() => {
    setEdit(null);
    setFeedback("");
    void refresh();
    return () => {
      revision.current++;
    };
  }, [kind]);
  return (
    <section className="cloud-page resource-library">
      <header className="cloud-page-heading">
        <div>
          <h2 className="jd-duplicate-title">专家与技能</h2>
          <p className="muted">
            角色与可复用步骤。
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => {
            setCreating(true);
            setEdit({
              name: "",
              description: "",
              instruction: "",
              body: "",
              skillIds: [],
            });
            setError("");
          }}
        >
          <Plus size={16} /> 创建{kind === "expert" ? "专家" : "技能"}
        </button>
      </header>
      <div className="cloud-tabs" role="tablist">
        <button
          role="tab"
          disabled={busy}
          aria-selected={kind === "expert"}
          onClick={() => setKind("expert")}
        >
          专家
        </button>
        <button
          role="tab"
          disabled={busy}
          aria-selected={kind === "skill"}
          onClick={() => setKind("skill")}
        >
          技能
        </button>
      </div>
      {kind === "skill" && <details className="library-import"><summary>导入技能包</summary><SkillPackImporter onImport={async files => { await api("/v1/skill-packs", "POST", { files }); setFeedback("技能包已导入，可以开始对话。"); await refresh(); }} /></details>}
      <div className="resource-toolbar">
        <div className="resource-filters" aria-label="资源分类">
          {[
            ["all", "全部"],
            ["mine", "我创建的"],
            ["bundled", "内置"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="library-search">
          <Search size={16} />
          <input
            aria-label="搜索专家与技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称或用途"
          />
        </label>
      </div>
      {error && !edit && !preview && !creating && <div role="alert" className="resource-error">{error}<button onClick={() => void refresh()} disabled={loading}>重新加载</button></div>}
      {feedback && <p role="status">{feedback}</p>}
      {(edit || preview || creating) && (
        <div
          className="resource-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label={
              preview
                ? (preview.displayName || preview.name)
                : `创建${kind === "expert" ? "专家" : "技能"}`
            }
            className="resource-dialog"
          >
            <header>
              <div>
                <span className="resource-eyebrow">
                  {preview ? "能力详情" : "构建你的专属能力"}
                </span>
                <h2>
                  {preview
                    ? (preview.displayName || preview.name)
                    : `${edit?.id ? "编辑" : "创建"}${kind === "expert" ? "专家" : "技能"}`}
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭详情"
                disabled={busy}
                onClick={close}
              >
                <X size={20} />
              </button>
            </header>
            {error && (
              <p role="alert" className="resource-error">
                {error}
              </p>
            )}
            {!preview && !edit?.id && (
              <div className="resource-draft">
                <h3>
                  <Sparkles size={17} /> 用一句话开始
                </h3>{" "}
                <form
                  className="cloud-search"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    setError("");
                    try {
                      const d = await api("/v1/resource-drafts", "POST", {
                        kind,
                        prompt,
                      });
                      setEdit(d.draft);
                      setFeedback("草稿已生成。检查内容后保存即可使用。");
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <input
                    aria-label="一句话创建"
                    required
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      kind === "expert"
                        ? "一句话描述想要的专家，例如：擅长代码审查的 TypeScript 工程师"
                        : "一句话描述技能，例如：按风险排序输出代码审查清单"
                    }
                  />
                  <button disabled={busy} className="primary-button">
                    {busy ? "正在生成…" : "生成草稿"}
                  </button>
                </form>
                <p className="muted">
                  生成后可以修改，也可以直接填写下面的内容。
                </p>
              </div>
            )}
            {preview && (
              <>
                <p>{preview.description}</p>
                <div className="resource-instructions">
                  <h3>{kind === "expert" ? "工作方式" : "技能指引"}</h3>
                  <pre>{preview.instruction || preview.body}</pre>
                </div>
                {kind === "skill" && <SkillPackFiles files={preview.files} />}
                {kind === "expert" && !!preview.skillIds?.length && <p>已绑定技能：{preview.skillIds.map(id => { const skill = skills.find(s => s.id === id); return skill?.displayName || skill?.name || id; }).join("、")}</p>}
                <button
                  className="primary-button"
                  onClick={() =>
                    onNewTask(
                      kind === "expert"
                        ? { expertId: preview.id }
                        : { skillIds: [preview.id] },
                    )
                  }
                >
                  开始对话 <ArrowUpRight size={15} />
                </button>
              </>
            )}
            {edit && (
              <form
                className="cloud-form cloud-editor"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError("");
                  try {
                    const payload = {
                      name: edit.name,
                      description: edit.description || "",
                      ...(kind === "expert"
                        ? {
                            instruction: edit.instruction,
                            skillIds: edit.skillIds || [],
                          }
                        : { body: edit.body, ...(edit.files ? { files: edit.files } : {}) }),
                    };
                    await api(
                      `/v1/${kind === "expert" ? "experts" : "skills"}${edit.id ? "/" + edit.id : ""}`,
                      edit.id ? "PATCH" : "POST",
                      payload,
                    );
                    setEdit(null);
                    setCreating(false);
                    setFeedback("已保存，可以用于新任务。");
                    await refresh();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <h3>
                  {edit.id ? "编辑" : "新建"}
                  {kind === "expert" ? "专家" : "技能"}
                </h3>
                <label>
                  名称
                  <input
                    required
                    maxLength={120}
                    value={edit.name || ""}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  />
                </label>
                <label>
                  简介
                  <input
                    value={edit.description || ""}
                    onChange={(e) =>
                      setEdit({ ...edit, description: e.target.value })
                    }
                  />
                </label>
                <label>
                  {kind === "expert" ? "专家指令" : "技能内容"}
                  <textarea
                    required
                    rows={8}
                    value={
                      (kind === "expert" ? edit.instruction : edit.body) || ""
                    }
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        [kind === "expert" ? "instruction" : "body"]:
                          e.target.value,
                      })
                    }
                  />
                </label>
                {kind === "expert" && skills.length > 0 && (
                  <fieldset>
                    <legend>搭配技能</legend>
                    {skills.map((s) => (
                      <label className="cloud-check" key={s.id}>
                        <input
                          type="checkbox"
                          checked={edit.skillIds?.includes(s.id) || false}
                          onChange={(e) =>
                            setEdit({
                              ...edit,
                              skillIds: e.target.checked
                                ? [...(edit.skillIds || []), s.id]
                                : (edit.skillIds || []).filter(
                                    (id) => id !== s.id,
                                  ),
                            })
                          }
                        />
                        {s.displayName || s.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="cloud-actions">
                  <button className="primary-button" disabled={busy}>
                    保存
                  </button>
                  <button type="button" onClick={close}>
                    取消
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      <a className="ecosystem-library-link" href="#/settings/extensions">浏览内置扩展 · 添加更多专家与技能 →</a>
      {loading ? (
        <p>正在加载…</p>
      ) : !items.length ? (
        <div className="cloud-note">
          还没有{kind === "expert" ? "专家" : "技能"}
          。用一句话生成草稿，或手动创建。
        </div>
      ) : (
        <div className="cloud-resource-grid">
          {items
            .filter(
              (item) =>
                (filter === "all" ||
                  (filter === "bundled" ? item.bundled : !item.bundled)) &&
                `${item.displayName || item.name} ${item.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
            )
            .map((item) => (
              <article className="cloud-card" key={item.id}>
                <div className="resource-avatar">
                  {kind === "expert" ? (
                    <Users size={23} />
                  ) : (
                    <BookOpen size={23} />
                  )}
                </div>
                <h3>
                  {item.displayName || item.name}
                  {item.bundled && <small> · 内置</small>}
                </h3>
                <p>{item.description || "暂无简介"}</p>
                <button
                  className="resource-detail"
                  onClick={() => setPreview(item)}
                >
                  查看详情
                </button>
                <div className="cloud-actions">
                  <button
                    className="primary-button"
                    onClick={() =>
                      onNewTask(
                        kind === "expert"
                          ? { expertId: item.id }
                          : { skillIds: [item.id] },
                      )
                    }
                  >
                    开始对话 <ArrowUpRight size={14} />
                  </button>
                  {!item.bundled && (
                    <button onClick={() => setEdit(item)}>编辑</button>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
      {!loading &&
        items.length > 0 &&
        !items.some(
          (item) =>
            (filter === "all" ||
              (filter === "bundled" ? item.bundled : !item.bundled)) &&
            `${item.displayName || item.name} ${item.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        ) && (
          <div className="cloud-note">
            没有找到匹配的内容。试试其他关键词或分类。
          </div>
        )}
    </section>
  );
}
