import { useEffect, useState, useRef } from "react";
import {
  BookOpen,
  Clock3,
  LogOut,
  Menu,
  Plus,
  Settings,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { CloudProjectHome } from "./CloudProjectHome";
import { CloudHomeRail } from "./CloudHomeRail";
import { CloudWorkspace } from "./CloudWorkspace";
import { CloudRunPanel } from "./CloudRunPanel";
import { CloudAutomationsPanel } from "./CloudAutomationsPanel";
import { CloudResourcesPanel } from "./CloudResourcesPanel";
import {
  CloudMemoryPanel,
  CloudRunsPanel,
  CloudSearchPanel,
  CloudSettingsPanel,
} from "./CloudAccountPanels";
import { cloudRequest as api, advanceCloudIdentity } from "./cloud-api";
import "./cloud-app.css";
import "./joydesk-workbench.css";
import { useDialog } from "../lib/use-dialog";
type Account = { id: string; name: string };
export function CloudAppShell() {
  const [account, setAccount] = useState<Account | null>(null),
    [loading, setLoading] = useState(true),
    [hash, setHash] = useState(location.hash),
    [navigation, setNavigation] = useState(false),
    [error, setError] = useState(""),
    [taskKey, setTaskKey] = useState(0),
    [options, setOptions] = useState<{
      expertId?: string;
      skillIds?: string[];
    }>({});
  const navigationDialog = useDialog<HTMLElement>(navigation, () =>
    setNavigation(false),
  );
  const identity = useRef<Account | null>(null);
  function changeAccount(a: Account | null) {
    if (identity.current?.id !== a?.id) advanceCloudIdentity();
    identity.current = a;
    setAccount(a);
  }
  useEffect(() => {
    let active = true;
    void api("/v1/me")
      .then((a) => {
        if (active) changeAccount(a);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    const changed = () => setHash(location.hash),
      expired = () => {
        changeAccount(null);
        setOptions({});
      };
    addEventListener("hashchange", changed);
    addEventListener("cloud-auth-expired", expired);
    return () => {
      active = false;
      removeEventListener("hashchange", changed);
      removeEventListener("cloud-auth-expired", expired);
    };
  }, []);
  const path = hash.split("?")[0] || "";
  const route = path.startsWith("#/projects")
    ? "projects"
    : path.match(
        /^#\/(experts|automations|memory|search|runs|settings)(?:\/|$)/,
      )?.[1] || "workstation";
  const titles: Record<string, string> = {
    workstation: "工作台",
    projects: "项目",
    experts: "专家与技能",
    automations: "自动化",
    memory: "记忆",
    search: "搜索",
    runs: "远端记录",
    settings: "设置",
  };
  const projectHomeId = path.match(/^#\/projects\/(project_[a-z0-9]+)\/overview$/)?.[1];
  const showTask = !projectHomeId && (route === "workstation" || route === "projects");
  function projectAction(id: string, panel?: string) {
    window.dispatchEvent(new CustomEvent("pig-cloud-intent", { detail: { projectId:id, panel } }));
    go("/conversations");
  }
  function go(path: string) {
    const next = path.startsWith("#") ? path : "#" + path;
    location.hash = next;
    setHash(next);
    setNavigation(false);
    setError("");
  }
  function newTask(value: typeof options = {}) {
    setOptions(value);
    setTaskKey((v) => v + 1);
    go("/conversations");
  }
  function conversation(id: string) {
    go("/conversations/" + id);
  }
  function run(id: string) {
    go("/runs/" + id);
  }
  const runId = hash.match(/^#\/runs\/(run_[a-z0-9]+)$/)?.[1];

  if (loading)
    return (
      <div className="cw-auth">
        <p role="status">正在连接工作台…</p>
      </div>
    );
  if (!account)
    return (
      <CloudWorkspace
        key="login"
        onAccount={(a) => {
          if (a) changeAccount(a);
        }}
      />
    );
  return (
    <div className={`app-layout cloud-app cloud-app-${route}`} key={account.id}>
      {navigation && (
        <button
          className="navigation-scrim"
          aria-label="关闭导航"
          onClick={() => setNavigation(false)}
        />
      )}
      <aside
        ref={navigationDialog}
        className={`global-sidebar ${navigation ? "is-open" : ""}`}
        aria-label="全局导航"
      >
        <div className="sidebar-brand jd-brand">
          <span className="brand-mark">P</span>
          <span className="jd-brand-copy">
            <strong>Pig Agent</strong>
            <em>云端沙箱</em>
          </span>
          <button
            className="icon-button mobile-only"
            aria-label="关闭导航"
            onClick={() => setNavigation(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="sidebar-new" onClick={() => newTask()}>
          <Plus size={17} />
          新对话
        </button>
        <nav className="global-links">
          {[
            {
              name: "skills",
              label: "技能",
              icon: Sparkles,
              path: "/experts/skills",
              selected: path === "#/experts/skills",
            },
            {
              name: "experts",
              label: "专家",
              icon: Users,
              path: "/experts",
              selected: route === "experts" && path !== "#/experts/skills",
            },
            {
              name: "automations",
              label: "自动化",
              icon: Clock3,
              path: "/automations",
              selected: route === "automations",
            },
            {
              name: "memory",
              label: "记忆",
              icon: BookOpen,
              path: "/memory",
              selected: route === "memory",
            },
          ].map((item) => (
            <button
              key={item.name}
              className={item.selected ? "selected" : ""}
              aria-current={item.selected ? "page" : undefined}
              onClick={() => go(item.path)}
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}
        </nav>
        <CloudHomeRail
          hash={hash}
          onOpenConversation={(id) => go("/conversations/" + id)}
          onOpenProject={(id) => go(`/projects/${id}/overview`)}
          onCreateProject={() => {
            window.dispatchEvent(
              new CustomEvent("pig-cloud-intent", {
                detail: { create: "personal" },
              }),
            );
            go("/conversations");
          }}
          onSearch={(q) => go("/search?q=" + encodeURIComponent(q))}
          onOpenRuns={() => go("/runs")}
          onShareProject={(id) => {
            window.dispatchEvent(
              new CustomEvent("pig-cloud-intent", {
                detail: { projectId: id, panel: "share" },
              }),
            );
            go("/conversations");
          }}
          onOpenMembers={(id) => {
            window.dispatchEvent(
              new CustomEvent("pig-cloud-intent", {
                detail: { projectId: id, panel: "members" },
              }),
            );
            go("/conversations");
          }}
          onOpenWorkspace={(id) => {
            window.dispatchEvent(
              new CustomEvent("pig-cloud-intent", {
                detail: { projectId: id, panel: "workspace" },
              }),
            );
            go("/conversations");
          }}
        />
        <div className="cloud-account">
          <span className="jd-account-name">
            <i>{account.name.slice(0, 1)}</i>
            <span>
              {account.name}
              <small>个人空间</small>
            </span>
          </span>
          <button
            aria-label="设置"
            onClick={() => go("/settings")}
            className={route === "settings" ? "selected" : ""}
          >
            <Settings size={16} />
          </button>
          <button
            aria-label="退出登录"
            onClick={async () => {
              try {
                await api("/auth/web/logout", "POST");
                changeAccount(null);
                setOptions({});
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="app-main">
        {!showTask && (
          <header className="task-header">
            <button
              className="icon-button mobile-only"
              data-navigation-trigger
              aria-label="打开导航"
              onClick={() => setNavigation(true)}
            >
              <Menu size={18} />
            </button>
            <div className="task-heading">
              <span className="context-label">Pig Agent</span>
              <h1>{titles[route]}</h1>
            </div>
          </header>
        )}
        {error && (
          <p className="cloud-shell-error" role="alert">
            {error}
          </p>
        )}
        <div className="cloud-shell-content" hidden={!showTask}>
          <CloudWorkspace
            key={taskKey}
            account={account}
            onAccount={(a) => {
              if (!a && identity.current?.id === account.id) changeAccount(null);
            }}
            embedded
            hashSync={showTask}
            onOpenNavigation={() => setNavigation(true)}
            onProjectCreated={(id) => go(`/projects/${id}/overview`)}
            initialBranch="personal"
            routePrefix="#/conversations"
            taskOptions={options}
          />
        </div>
        {!showTask && (
          <div className="cloud-shell-content">
            {projectHomeId ? (
              <CloudProjectHome key={projectHomeId} projectId={projectHomeId} onConversation={conversation} onStart={() => projectAction(projectHomeId)} onWorkspace={() => projectAction(projectHomeId,"workspace")} onManage={() => projectAction(projectHomeId,"manage")} onRun={run} />
            ) : route === "experts" ? (
              <CloudResourcesPanel
                initialKind={path === "#/experts/skills" ? "skill" : "expert"}
                onNewTask={newTask}
              />
            ) : route === "automations" ? (
              <CloudAutomationsPanel onRun={(id) => void run(id)} />
            ) : route === "settings" ? (
              <CloudSettingsPanel />
            ) : route === "memory" ? (
              <CloudMemoryPanel />
            ) : route === "search" ? (
              <CloudSearchPanel onConversation={conversation} />
            ) : runId ? (
              <CloudRunPanel runId={runId} onClose={() => go("/runs")} />
            ) : (
              <CloudRunsPanel onRun={(id) => void run(id)} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
