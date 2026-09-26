import { SkillPackFiles } from "./SkillPackView";
import { McpPanel } from "./McpPanel";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Box,
  Check,
  Download,
  Package,
  Search,
  X,
} from "lucide-react";
import type {
  EcosystemPlugin,
  InstalledPlugin,
  PluginManifest,
} from "@pig-agent/contracts";
import "./extensions.css";

async function localRequest(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Error(typeof value.error === "string" ? value.error : "操作失败");
  return value;
}
type Props = { mode?: "local" | "cloud"; request?: typeof localRequest; onBrowseResources?: () => void };
export function ExtensionsPanel({
  mode = "local",
  request = localRequest,
  onBrowseResources,
}: Props) {
  const preview = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  const base = mode === "cloud" ? "/v1/plugins" : "/api/plugins";
  const [catalog, setCatalog] = useState<EcosystemPlugin[]>([]),
    [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [tab, setTab] = useState<"catalog" | "installed" | "mcp">("catalog"),
    [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginManifest | null>(null),
    [draft, setDraft] = useState<PluginManifest | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([request(base + "/catalog"), request(base)])
      .then(([c, p]) => {
        if (active) {
          setCatalog(c.catalog);
          setPlugins(p.plugins);
        }
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
  }, [base, request, reload]);
  useEffect(() => {
    const element = selected ? preview.current : heading.current;
    element?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selected]);

  async function act(id: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError("");
    setFeedback("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  async function install(id: string) {
    await act(id, async () => {
      const data = await request(
        `${base}/catalog/${encodeURIComponent(id)}`,
        "POST",
      );
      setPlugins(data.plugins);
      setFeedback("已安装，尚未启用。检查内容后启用即可选择专家与技能。");
    });
  }
  async function toggle(p: InstalledPlugin) {
    await act(p.manifest.id, async () => {
      const data = await request(
        `${base}/${encodeURIComponent(p.manifest.id)}`,
        "PATCH",
        { enabled: !p.enabled },
      );
      setPlugins(data.plugins);
      setFeedback(
        p.enabled
          ? "已停用，后续任务不再加载此包。运行中和历史任务保持原上下文。"
          : "已启用，可在任务中选择这些专家与技能。",
      );
    });
  }
  const search = (text: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  const matches = (pack: PluginManifest | EcosystemPlugin) =>
    search(
      [
        pack.name,
        pack.description,
        ...pack.skills.map((s) => `${s.name} ${s.description}`),
        ...pack.experts.map((e) => `${e.name} ${e.description}`),
      ].join(" "),
    );
  const selectedInstall = plugins.find(p => p.manifest.id === selected?.id);
  const visibleCatalog = catalog.filter(matches),
    visibleInstalled = plugins.filter((p) => matches(p.manifest));
  return (
    <section className="ecosystem-panel" aria-label="插件管理">
      <header ref={heading} className="ecosystem-heading">
        <div>
          <span className="ecosystem-eyebrow">PIG · 扩展</span>
          <h3>{tab === "mcp" ? "连接工作所需的工具" : "为工作台添加专长"}</h3>
          <p>
            {tab === "mcp"
              ? "先测试连接，再按任务需要启用。"
              : "专家、操作指南、脚本与参考资料，先查看再启用。"}
            {mode === "cloud" ? "仅属于当前云账号。" : "保存在当前工作台。"}
          </p>
        </div>
        <span className="ecosystem-emblem">
          <Package size={25} />
        </span>
      </header>
      <div hidden={!!selected}>
        <div className="ecosystem-toolbar">
          <div className="ecosystem-tabs" aria-label="扩展分类">
            <button
              type="button"
              aria-pressed={tab === "catalog"}
              onClick={() => setTab("catalog")}
            >
              发现扩展
            </button>
            <button
              type="button"
              aria-pressed={tab === "installed"}
              onClick={() => setTab("installed")}
            >
              已安装 <span>{plugins.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={tab === "mcp"}
              onClick={() => setTab("mcp")}
            >
              MCP 连接
            </button>
          </div>
          {tab !== "mcp" && (
            <label className="ecosystem-search">
              <Search size={16} />
              <input
                aria-label="搜索扩展"
                placeholder="搜索专长、专家或技能"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          )}
        </div>
        {tab === "mcp" ? (
          <McpPanel
            mode={mode}
            request={mode === "cloud" ? request : undefined}
          />
        ) : (
          <>
            {error && (
              <div className="ecosystem-error" role="alert">
                {error}
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setReload((v) => v + 1)}
                >
                  重新加载
                </button>
              </div>
            )}
            {feedback && (
              <p className="ecosystem-feedback" role="status">
                <Check size={16} />
                {feedback}
              </p>
            )}
            {loading ? (
              <p className="ecosystem-empty" role="status">
                正在读取扩展…
              </p>
            ) : (
              <>
                <div className="ecosystem-grid">
                  {tab === "catalog"
                    ? visibleCatalog.map((pack) => {
                        const installed = plugins.find(
                          (p) => p.manifest.id === pack.id,
                        );
                        const { purpose: _purpose, ...content } = pack;
                        return (
                          <article className="ecosystem-card" key={pack.id}>
                            <div className="ecosystem-card-top">
                              <span className="ecosystem-icon">
                                <BookOpen size={19} />
                              </span>
                              <span className="ecosystem-badge">
                                内置 · {pack.version}
                              </span>
                            </div>
                            <h4>{pack.name}</h4>
                            <p>{pack.description}</p>
                            <div className="ecosystem-meta">
                              {pack.experts.length} 位专家 <span>·</span>{" "}
                              {pack.skills.length} 项技能
                            </div>
                            <div className="ecosystem-card-actions">
                              <button
                                type="button"
                                onClick={() =>
                                  setSelected({
                                    format: "pig-plugin-v1",
                                    ...content,
                                  })
                                }
                              >
                                查看内容
                              </button>
                              {installed ? (
                                <button
                                  type="button"
                                  onClick={() => setTab("installed")}
                                >
                                  <Check size={14} />
                                  {installed.enabled ? "已启用" : "已安装"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="ecosystem-primary"
                                  disabled={!!busy}
                                  onClick={() => void install(pack.id)}
                                >
                                  <Download size={14} />
                                  {busy === pack.id ? "安装中…" : "安装"}
                                </button>
                              )}
                            </div>
                          </article>
                        );
                      })
                    : visibleInstalled.map((p) => (
                        <article className="ecosystem-card" key={p.manifest.id}>
                          <div className="ecosystem-card-top">
                            <span className="ecosystem-icon">
                              <Box size={19} />
                            </span>
                            <span
                              className={`ecosystem-badge ${p.enabled ? "active" : ""}`}
                            >
                              {p.enabled ? "已启用" : "未启用"}
                            </span>
                          </div>
                          <h4>{p.manifest.name}</h4>
                          <p>{p.manifest.description}</p>
                          <div className="ecosystem-meta">
                            v{p.manifest.version} <span>·</span>{" "}
                            {p.manifest.experts.length} 专家 /{" "}
                            {p.manifest.skills.length} 技能
                          </div>
                          <div className="ecosystem-card-actions">
                            <button
                              type="button"
                              onClick={() => setSelected(p.manifest)}
                            >
                              查看内容
                            </button>
                            <button
                              type="button"
                              className={p.enabled ? "" : "ecosystem-primary"}
                              disabled={!!busy}
                              onClick={() => void toggle(p)}
                            >
                              {busy === p.manifest.id
                                ? "处理中…"
                                : p.enabled
                                  ? "停用"
                                  : "启用"}
                            </button>
                            <button
                              type="button"
                              disabled={!!busy || p.enabled}
                              title={
                                p.enabled ? "先停用再移除" : "历史任务保持不变"
                              }
                              onClick={() =>
                                void act(p.manifest.id, async () => {
                                  const data = await request(
                                    `${base}/${encodeURIComponent(p.manifest.id)}`,
                                    "DELETE",
                                  );
                                  setPlugins(data.plugins);
                                  setFeedback("已移除，历史任务保持不变。");
                                })
                              }
                            >
                              移除
                            </button>
                          </div>
                        </article>
                      ))}
                </div>
                {(tab === "catalog" ? visibleCatalog : visibleInstalled)
                  .length === 0 && (
                  <div className="ecosystem-empty">
                    <Package size={24} />
                    <strong>
                      {query ? "没有找到匹配的扩展" : "还没有安装扩展"}
                    </strong>
                    <p>
                      {query
                        ? "换一个关键词试试。"
                        : "从发现页选择一个工作方法包开始。"}
                    </p>
                    {!query && (
                      <button type="button" onClick={() => setTab("catalog")}>
                        浏览内置扩展
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            <p className="ecosystem-scope">
              扩展包提供专家、技能及可审阅的脚本与参考资料，不自动运行脚本、不安装依赖，也不增加工具权限。启用后，所选内容可能发送给当前模型提供商。外部工具通过
              MCP 单独连接与审批。
            </p>
            {mode === "local" && (
              <details className="ecosystem-import">
                <summary>导入自己的插件包</summary>
                <label>
                  选择 pig-plugin-v1 JSON 文件
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={!!busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file)
                        void act("import", async () => {
                          setDraft(null);
                          if (file.size > 600000)
                            throw Error("文件不能超过 600 KB");
                          const data = await request(
                            base + "/preview",
                            "POST",
                            JSON.parse(await file.text()),
                          );
                          setDraft(data.manifest);
                          setSelected(data.manifest);
                        });
                    }}
                  />
                </label>
              </details>
            )}
          </>
        )}
      </div>
      {selected && (
        <div
          ref={preview}
          className="ecosystem-detail"
          role="region"
          aria-label="扩展内容"
        >
          <header>
            <div>
              <span className="ecosystem-eyebrow">
                内容预览 · v{selected.version}
              </span>
              <h4>{selected.name}</h4>
            </div>
            <button
              type="button"
              aria-label="关闭扩展预览"
              onClick={() => {
                setSelected(null);
                setDraft(null);
              }}
            >
              <X size={18} />
            </button>
          </header>
          <p>{selected.description}</p>
          {error && <p className="ecosystem-error" role="alert">{error}</p>}
          {feedback && <p className="ecosystem-feedback" role="status">{feedback}</p>}
          {!draft && <div className="ecosystem-detail-actions">
            {selectedInstall ? <button type="button" className="ecosystem-primary" disabled={!!busy} onClick={() => void toggle(selectedInstall)}>
              {busy === selected.id ? "处理中…" : selectedInstall.enabled ? "停用此扩展" : "启用此扩展"}
            </button> : <button type="button" className="ecosystem-primary" disabled={!!busy} onClick={() => void install(selected.id)}>
              {busy === selected.id ? "安装中…" : "安装此扩展"}
            </button>}
            {selectedInstall?.enabled && <a href="#/experts" onClick={onBrowseResources}>选择专家与技能，开始使用 →</a>}
            <span>安装后默认停用；启用不会自动执行工具。</span>
          </div>}
          {selected.experts.map((expert) => (
            <details key={"e" + expert.id}>
              <summary>专家 · {expert.name}</summary>
              <p>{expert.description}</p>
              <pre>{expert.instruction}</pre>
              <small>
                配套技能：
                {expert.skillIds
                  .map(
                    (id) =>
                      selected.skills.find((s) => s.id === id)?.name || id,
                  )
                  .join("、") || "无"}
              </small>
            </details>
          ))}
          {selected.skills.map((skill) => (
            <details key={"s" + skill.id} open>
              <summary>技能 · {skill.name}</summary>
              <p>{skill.description}</p>
              <details><summary>查看操作指南</summary><pre>{skill.body}</pre></details>
              <SkillPackFiles files={skill.files} />
            </details>
          ))}
          {draft && (
            <button
              type="button"
              className="ecosystem-primary"
              disabled={!!busy}
              onClick={() =>
                void act("import", async () => {
                  const data = await request(base, "POST", draft);
                  setPlugins(data.plugins);
                  setSelected(null);
                  setDraft(null);
                  setTab("installed");
                  setFeedback("已导入，尚未启用。");
                })
              }
            >
              确认导入，暂不启用
            </button>
          )}
        </div>
      )}
    </section>
  );
}
