import { Fragment, useEffect, useState, useRef } from "react";
import {
  BookOpen,
  Clock3,
  Layers,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Server,
  Settings,
  Users,
  X,
} from "lucide-react";
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
  const lastConversation = useRef("");
  function changeAccount(a: Account | null) {
    if (identity.current?.id !== a?.id) advanceCloudIdentity();
    if (identity.current?.id !== a?.id) lastConversation.current = "";
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
  const branch = hash.startsWith("#/projects/collaboration")
    ? "collaborative"
    : "personal";
  const route = hash.startsWith("#/projects")
    ? "projects"
    : hash.match(
        /^#\/(experts|automations|memory|search|runs|settings)(?:\/|$)/,
      )?.[1] || "workstation";
  const titles: Record<string, string> = {
    workstation: "工作台",
    projects: branch === "collaborative" ? "项目协同" : "普通项目",
    experts: "专家与技能",
    automations: "自动化",
    memory: "记忆",
    search: "搜索",
    runs: "远端记录",
    settings: "设置",
  };
  function go(path: string) {
    const previous = location.hash.match(/\/(conv_[a-z0-9]+)$/)?.[1];
    if (previous) lastConversation.current = previous;
    if (path.startsWith("/projects")) setOptions({});
    location.hash = path;
    setHash("#" + path);
    setNavigation(false);
    setError("");
  }
  function newTask(value: typeof options = {}) {
    setOptions(value);
    setTaskKey((v) => v + 1);
    go("/conversations");
    lastConversation.current = "";
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
        <div className="sidebar-brand">
          <span className="brand-mark">P</span>
          <strong>Pig Agent</strong>
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
          新任务
        </button>
        <nav className="global-links">
          {[
            {
              name: "workstation",
              label: "工作台",
              icon: MessageSquare,
              path: lastConversation.current
                ? "/conversations/" + lastConversation.current
                : "/conversations",
            },
            {
              name: "projects",
              label: "项目",
              icon: Layers,
              path: "/projects/personal",
            },
            { name: "experts", label: "专家", icon: Users, path: "/experts" },
            {
              name: "automations",
              label: "自动化",
              icon: Clock3,
              path: "/automations",
            },
            { name: "memory", label: "记忆", icon: BookOpen, path: "/memory" },
            { name: "search", label: "搜索", icon: Search, path: "/search" },
            { name: "runs", label: "远端记录", icon: Server, path: "/runs" },
          ].map((item) => (
            <Fragment key={item.name}>
              <button
                className={route === item.name ? "selected" : ""}
                aria-current={route === item.name ? "page" : undefined}
                onClick={() => go(item.path)}
              >
                <item.icon size={17} />
                {item.label}
              </button>
              {item.name === "projects" && route === "projects" && (
                <nav className="project-branches" aria-label="项目分支">
                  <button
                    className={branch === "personal" ? "selected" : ""}
                    onClick={() => go("/projects/personal")}
                  >
                    普通项目
                  </button>
                  <button
                    className={branch === "collaborative" ? "selected" : ""}
                    onClick={() => go("/projects/collaboration")}
                  >
                    <Users size={15} />
                    项目协同
                  </button>
                </nav>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="cloud-account">
          <span>{account.name}</span>
          <small>远端执行 · 沙箱隔离</small>
          <button
            onClick={() => go("/settings")}
            className={route === "settings" ? "selected" : ""}
          >
            <Settings size={17} />
            设置
          </button>
          <button
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
            <LogOut size={17} />
            退出登录
          </button>
        </div>
      </aside>
      <main className="app-main">
        {route !== "workstation" && route !== "projects" && (
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
        <div className="cloud-shell-content">
          {route === "workstation" || route === "projects" ? (
            <CloudWorkspace
              key={`${route}-${branch}-${taskKey}`}
              account={account}
              onAccount={(a) => {
                if (!a && identity.current?.id === account.id)
                  changeAccount(null);
              }}
              embedded
              onOpenNavigation={() => setNavigation(true)}
              initialBranch={branch}
              routePrefix={
                route === "projects"
                  ? `#/projects/${branch === "collaborative" ? "collaboration" : "personal"}`
                  : "#/conversations"
              }
              taskOptions={route === "workstation" ? options : {}}
            />
          ) : route === "experts" ? (
            <CloudResourcesPanel onNewTask={newTask} />
          ) : route === "automations" ? (
            <CloudAutomationsPanel onRun={(id) => void run(id)} />
          ) : route === "settings" ? (
            <CloudSettingsPanel />
          ) : route === "memory" ? (
            <CloudMemoryPanel />
          ) : route === "search" ? (
            <CloudSearchPanel onConversation={conversation} />
          ) : (
            <>
              {runId ? (
                <CloudRunPanel runId={runId} onClose={() => go("/runs")} />
              ) : (
                <CloudRunsPanel onRun={(id) => void run(id)} />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
