import { useEffect, useState } from "react";
import {
  ArrowRight,
  FileText,
  FolderKanban,
  MessageSquare,
  Plus,
  Users,
} from "lucide-react";
import type {
  CloudProject,
  CloudProjectWorkspace,
} from "@pig-agent/contracts/cloud";
import { cloudRequest } from "./cloud-api";
import "./cloud-project-home.css";

export function CloudProjectHome({
  projectId,
  onConversation,
  onStart,
  onManage,
  onWorkspace,
  onRun,
}: {
  projectId: string;
  onConversation: (id: string) => void;
  onStart: () => void;
  onManage: () => void;
  onWorkspace: () => void;
  onRun: (id: string) => void;
}) {
  const [project, setProject] = useState<CloudProject>();
  const [workspace, setWorkspace] = useState<CloudProjectWorkspace>();
  const [tab, setTab] = useState<
    "overview" | "conversations" | "files" | "about"
  >("overview");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setProject(undefined);
    setWorkspace(undefined);
    Promise.all([
      cloudRequest("/v1/projects"),
      cloudRequest(`/v1/projects/${projectId}/workspace`),
    ])
      .then(([catalog, files]) => {
        if (!active) return;
        const found = catalog.projects.find(
          (p: CloudProject) => p.id === projectId,
        );
        if (!found) throw Error("项目不存在或你已没有访问权限");
        setProject(found);
        setWorkspace(files);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, revision]);
  const conversations = workspace?.conversations || [];
  const visible = conversations.filter((c) =>
    c.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const versions = conversations.reduce((n, c) => n + c.versions.length, 0);
  if (loading)
    return (
      <div className="project-home">
        <p role="status">正在读取项目…</p>
      </div>
    );
  if (error || !project)
    return (
      <div className="project-home">
        <p role="alert">{error || "项目不可用"}</p>
        <button onClick={() => setRevision((n) => n + 1)}>重试</button>
      </div>
    );
  return (
    <section className="project-home" aria-label="项目主页">
      <header className="project-heading">
        <div className="project-identity">
          <span className="project-symbol">
            <FolderKanban size={24} />
          </span>
          <div>
            <h1>{project.name}</h1>
            <p>
              {project.kind === "collaborative"
                ? `${project.space_name} · 项目协同`
                : "我的项目 · 仅自己可见"}
            </p>
          </div>
        </div>
        <div className="project-header-actions">
          <button onClick={onManage}>
            <Users size={15} />
            {project.kind === "collaborative" ? "成员与权限" : "项目协同"}
          </button>
          <button
            className="primary-button"
            disabled={project.role === "viewer"}
            onClick={onStart}
          >
            <Plus size={16} />
            发起项目对话
          </button>
        </div>
      </header>
      <nav className="project-tabs" aria-label="项目页面">
        {(
          [
            ["overview", "概览"],
            ["conversations", "项目对话"],
            ["files", "工作区与文件"],
            ["about", "项目说明"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <>
          <div className="project-intro">
            <h2>继续推进你的项目</h2>
            <p>
              {project.description ||
                "将相关任务放在一起，在同一个项目中继续工作。"}
            </p>
          </div>
          <div className="project-stats">
            <button onClick={() => setTab("conversations")}>
              <MessageSquare size={20} />
              <span>项目对话</span>
              <strong>{conversations.length}</strong>
            </button>
            <button onClick={() => setTab("files")}>
              <FileText size={20} />
              <span>初始工作区文件</span>
              <strong>{workspace?.seed?.fileCount || 0}</strong>
            </button>
            <button onClick={() => setTab("files")}>
              <FolderKanban size={20} />
              <span>保存的任务版本</span>
              <strong>{versions}</strong>
            </button>
          </div>
          <section className="project-section">
            <header>
              <h2>最近对话</h2>
              <button onClick={() => setTab("conversations")}>
                查看全部 <ArrowRight size={14} />
              </button>
            </header>
            {conversations.length ? (
              conversations.slice(0, 5).map((c) => (
                <button
                  className="project-conversation"
                  key={c.id}
                  onClick={() => onConversation(c.id)}
                >
                  <MessageSquare size={17} />
                  <span>{c.title}</span>
                  <small>{c.versions.length} 个版本</small>
                  <ArrowRight size={15} />
                </button>
              ))
            ) : (
              <div className="project-empty">
                <MessageSquare size={28} />
                <h3>从第一个项目对话开始</h3>
                <p>对话和产生的文件版本会归属到这个项目。</p>
                <button disabled={project.role === "viewer"} onClick={onStart}>
                  发起项目对话
                </button>
              </div>
            )}
          </section>
        </>
      )}
      {tab === "conversations" && (
        <section className="project-section">
          <header>
            <h2>项目对话</h2>
            <input
              aria-label="搜索项目对话"
              placeholder="搜索对话"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </header>
          {visible.map((c) => (
            <button
              className="project-conversation"
              key={c.id}
              onClick={() => onConversation(c.id)}
            >
              <MessageSquare size={17} />
              <span>{c.title}</span>
              <small>{c.versions.length} 个版本</small>
              <ArrowRight size={15} />
            </button>
          ))}
          {!visible.length && (
            <div className="project-empty">
              <h3>{query ? "没有匹配的对话" : "还没有项目对话"}</h3>
              <p>{query ? "试试其他关键词。" : "点击上方按钮开始一项任务。"}</p>
            </div>
          )}
        </section>
      )}
      {tab === "files" && (
        <>
          <div className="project-intro">
            <h2>{workspace?.workspaceName || "项目工作区"}</h2>
            <p>
              初始文件用于新任务；每个对话保存各自的工作区版本，不会互相覆盖。
            </p>
            <button onClick={onWorkspace}>
              打开工作区管理 <ArrowRight size={14} />
            </button>
          </div>
          <section className="project-section">
            <header>
              <h2>初始文件</h2>
              <small>{workspace?.seed?.fileCount || 0} 个</small>
            </header>
            {workspace?.seed?.files.length ? (
              workspace.seed.files.map((f) => (
                <div className="project-file" key={f}>
                  <FileText size={16} />
                  <span>{f}</span>
                </div>
              ))
            ) : (
              <div className="project-empty">
                <p>没有导入初始文件。你也可以在对话中上传任务附件。</p>
              </div>
            )}
          </section>
          <section className="project-section">
            <header>
              <h2>任务文件版本</h2>
            </header>
            {conversations
              .filter((c) => c.versions.length)
              .map((c) => (
                <div key={c.id} className="project-version-group">
                  <h3>{c.title}</h3>
                  {c.versions.map((v) => (
                    <button
                      className="project-conversation"
                      key={v.run_id}
                      onClick={() => onRun(v.run_id)}
                    >
                      <FolderKanban size={16} />
                      <span>{new Date(v.created_at).toLocaleString()}</span>
                      <small>{v.manifest.files?.length || 0} 个文件</small>
                      <ArrowRight size={15} />
                    </button>
                  ))}
                </div>
              ))}
            {!versions && (
              <div className="project-empty">
                <p>任务完成后，可在这里打开对应运行并检查文件成果。</p>
              </div>
            )}
          </section>
        </>
      )}
      {tab === "about" && (
        <section className="project-section project-about">
          <h2>项目说明</h2>
          <p>{project.description || "创建项目时未填写说明。"}</p>
          <dl>
            <dt>工作区</dt>
            <dd>{project.workspace_name || "工作区"}</dd>
            <dt>我的权限</dt>
            <dd>
              {
                { admin: "管理员", editor: "可编辑", viewer: "只读" }[
                  project.role
                ]
              }
            </dd>
            <dt>执行环境</dt>
            <dd>云端 Runner 原生沙箱</dd>
          </dl>
          <p>协同项目的写入与命令需要审批。权限由控制面校验。</p>
          <button onClick={onManage}>
            {project.kind === "collaborative"
              ? "管理成员与权限"
              : "将项目共享给团队"}
          </button>
        </section>
      )}
    </section>
  );
}
