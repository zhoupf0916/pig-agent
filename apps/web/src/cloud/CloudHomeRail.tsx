import { useEffect, useState } from "react";
import { ChevronRight, FileText, Plus, Search, Server, Share2, Users } from "lucide-react";
import { cloudRequest } from "./cloud-api";

type Project = {
  id: string;
  name: string;
  kind: "personal" | "collaborative";
};
type Conversation = {
  id: string;
  title: string;
  project_id?: string | null;
  updated_at?: string;
};

function dayDiff(iso: string | undefined, now = new Date()) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((start.getTime() - day.getTime()) / 86_400_000);
}

function bucket(iso?: string) {
  return dayDiff(iso) < 7 ? "最近 7 天" : "更早";
}

function relativeTime(iso?: string) {
  const diff = dayDiff(iso);
  if (!Number.isFinite(diff)) return "";
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天`;
  const date = new Date(iso!);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function conversationTitle(title?: string) {
  const line = (title || "").split("\n").map((part) => part.trim()).find(Boolean);
  return line || "未命名对话";
}

export function CloudHomeRail({
  hash,
  onOpenConversation,
  onOpenProject,
  onCreateProject,
  onOpenWorkspace,
  onOpenMembers,
  onShareProject,
  onSearch,
  onOpenRuns,
}: {
  hash: string;
  onOpenConversation: (id: string) => void;
  onOpenProject: (id: string) => void;
  onCreateProject: () => void;
  onOpenWorkspace: (projectId: string) => void;
  onOpenMembers: (projectId: string) => void;
  onShareProject: (projectId: string) => void;
  onSearch: (query: string) => void;
  onOpenRuns: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const path = hash.split("?")[0] || "";
  const activeConversation = path.match(/conv_[a-z0-9]+/)?.[0] || "";
  const activeProject = activeConversation
    ? conversations.find((item) => item.id === activeConversation)?.project_id ||
      ""
    : path.match(/^#\/projects\/(project_[a-z0-9]+)\/overview$/)?.[1] || pinned;
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [projectData, conversationData] = await Promise.all([
          cloudRequest("/v1/projects"),
          cloudRequest("/v1/conversations"),
        ]);
        if (!alive) return;
        setProjects(projectData.projects || []);
        setConversations(conversationData.conversations || []);
        setError("");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    const onCatalog = () => void load();
    window.addEventListener("pig-cloud-catalog", onCatalog);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("pig-cloud-catalog", onCatalog);
    };
  }, []);

  const matches = (item: Conversation) =>
    !needle || conversationTitle(item.title).toLowerCase().includes(needle);
  const loose = conversations.filter((item) => !item.project_id && matches(item));
  const groups = ["最近 7 天", "更早"].map((label) => ({
    label,
    items: loose.filter((item) => bucket(item.updated_at) === label),
  }));

  return (
    <nav className="jd-rail" aria-label="项目与对话">
      <form
        className="jd-rail-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) onSearch(query.trim());
        }}
      >
        <Search size={14} />
        <input
          aria-label="搜索对话"
          placeholder="搜索对话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>
      {needle && (
        <button className="jd-create" type="button" onClick={() => onSearch(query.trim())}>
          搜索消息
        </button>
      )}
      <div className="jd-section-label">项目</div>
      {projects.map((project) => {
        const nested = conversations.filter(
          (item) => item.project_id === project.id && matches(item),
        );
        if (needle && !project.name.toLowerCase().includes(needle) && !nested.length)
          return null;
        const open = collapsed[project.id] === false || (collapsed[project.id] === undefined && activeProject === project.id);
        return (
          <div className="jd-project" key={project.id}>
            <div className="jd-project-row">
              <button
                className="jd-chevron"
                type="button"
                aria-label={open ? `折叠${project.name}` : `展开${project.name}`}
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((current) => ({
                    ...current,
                    [project.id]: open,
                  }))
                }
              >
                <ChevronRight size={14} className={open ? "is-open" : ""} />
              </button>
              <button
                className={
                  activeProject === project.id && !activeConversation
                    ? "selected"
                    : ""
                }
                type="button"
                onClick={() => {
                  if (!open)
                    setCollapsed((current) => ({
                      ...current,
                      [project.id]: false,
                    }));
                  setPinned(project.id);
                  onOpenProject(project.id);
                }}
              >
                <span>{project.name}</span>
                {project.kind === "collaborative" && <em>共享</em>}
              </button>
              {project.kind === "collaborative" ? (
                <button
                  className="jd-icon"
                  type="button"
                  aria-label={`${project.name}的成员`}
                  onClick={() => onOpenMembers(project.id)}
                >
                  <Users size={14} />
                </button>
              ) : (
                <>
                  <button
                    className="jd-icon"
                    type="button"
                    aria-label={`共享${project.name}`}
                    onClick={() => onShareProject(project.id)}
                  >
                    <Share2 size={14} />
                  </button>
                  <button
                    className="jd-icon"
                    type="button"
                    aria-label={`查看${project.name}的工作区`}
                    onClick={() => onOpenWorkspace(project.id)}
                  >
                    <FileText size={14} />
                  </button>
                </>
              )}
            </div>
            {open &&
              nested.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`jd-chat ${activeConversation === item.id ? "selected" : ""}`}
                  onClick={() => {
                    setPinned("");
                    onOpenConversation(item.id);
                  }}
                >
                  <span>{conversationTitle(item.title)}</span>
                  <time>{relativeTime(item.updated_at)}</time>
                </button>
              ))}
            {open && !nested.length && (
              <p className="jd-empty">这个项目还没有对话</p>
            )}
          </div>
        );
      })}
      {!projects.length && !error && <p className="jd-empty">还没有项目</p>}
      {error && <p className="jd-empty">{error}</p>}
      <button className="jd-create" type="button" onClick={onCreateProject}>
        <Plus size={14} />
        新建项目
      </button>
      {groups.some((group) => group.items.length > 0) && (
        <>
          <div className="jd-section-label">对话</div>
          {groups.map(
            (group) =>
              group.items.length > 0 && (
                <div key={group.label}>
                  <div className="jd-bucket">{group.label}</div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`jd-chat ${activeConversation === item.id ? "selected" : ""}`}
                      onClick={() => {
                        setPinned("");
                        onOpenConversation(item.id);
                      }}
                    >
                      <span>{conversationTitle(item.title)}</span>
                      <time>{relativeTime(item.updated_at)}</time>
                    </button>
                  ))}
                </div>
              ),
          )}
        </>
      )}
      <button className="jd-create" type="button" onClick={onOpenRuns}>
        <Server size={14} />
        远端记录
      </button>
    </nav>
  );
}
