import { useState } from "react";
import type { Skill, SkillMeta } from "../types";
import { SkillPackFiles, SkillPackImporter } from "./SkillPackView";
import { useDialog } from "../lib/use-dialog";
import { ResourceCreator } from "./ResourceCreator";

export function SkillsLibrary({
  skills,
  onUse,
  onRefresh,
}: {
  skills: SkillMeta[];
  onUse: (id: string) => void;
  onRefresh: () => void;
}) {
  const [preview, setPreview] = useState<Skill | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");
  const ref = useDialog<HTMLDivElement>(!!preview, () => setPreview(null));
  return (
    <div className="local-skills-library">
      <header className="resource-toolbar">
        <p>可复用的操作指南、脚本与参考资料</p>
        <input
          className="field"
          aria-label="搜索技能"
          placeholder="搜索中文名称或用途"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>
      <SkillPackImporter
        onImport={async (files) => {
          const response = await fetch("/api/skill-packs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files }),
          });
          const result = await response.json();
          if (!response.ok) throw Error(result.error);
          onRefresh();
        }}
      />
      <ResourceCreator kind="skill" onCreated={onRefresh} />
      {error && <p role="alert">{error}</p>}
      <div className="cloud-resource-grid">
        {skills
          .filter((s) =>
            `${s.displayName || s.name} ${s.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((skill) => (
            <article className="cloud-card" key={skill.name}>
              <h3>{skill.displayName || skill.name}</h3>
              <p>{skill.description}</p>
              <div className="cloud-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onUse(skill.name)}
                >
                  开始对话 ↗
                </button>
                <button
                  type="button"
                  disabled={!!loading}
                  onClick={async () => {
                    setLoading(skill.name);
                    setError("");
                    try {
                      const response = await fetch(
                        `/api/skills/${encodeURIComponent(skill.name)}`,
                      );
                      const result = await response.json();
                      if (!response.ok) throw Error(result.error);
                      setPreview(result);
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setLoading("");
                    }
                  }}
                >
                  {loading === skill.name ? "正在加载…" : "查看技能包"}
                </button>
              </div>
            </article>
          ))}
      </div>
      {!skills.some((s) =>
        `${s.displayName || s.name} ${s.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) && <p role="status">没有找到匹配的技能。</p>}
      {preview && (
        <div className="resource-overlay">
          <div
            className="resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={preview.displayName || preview.name}
            ref={ref}
          >
            <header>
              <h2>{preview.displayName || preview.name}</h2>
              <button type="button" onClick={() => setPreview(null)}>
                关闭
              </button>
            </header>
            <p>{preview.description}</p>
            <div className="resource-instructions">
              <h3>操作指南 · SKILL.md</h3>
              <pre>{preview.body}</pre>
            </div>
            <SkillPackFiles files={preview.files} />
            <button
              type="button"
              className="primary-button"
              onClick={() => onUse(preview.name)}
            >
              使用此技能开始对话 ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
