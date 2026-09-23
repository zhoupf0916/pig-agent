import { useEffect, useRef, useState } from "react";
import type { McpServerView, McpToolView } from "@pig-agent/contracts";
async function defaultRequest(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(130000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Error(typeof value.error === "string" ? value.error : "操作失败");
  return value;
}
export function McpPanel({
  mode,
  base,
  request = defaultRequest,
}: {
  mode: "local" | "cloud";
  base?: string;
  request?: typeof defaultRequest;
}) {
  const root =
    base ?? (mode === "local" ? "/api/mcp/servers" : "/v1/mcp/servers");
  const [servers, setServers] = useState<McpServerView[]>([]),
    [tools, setTools] = useState<McpToolView[]>([]);
  const [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [timeoutMs, setTimeoutMs] = useState(15000),
    [secret, setSecret] = useState(""),
    [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [reload, setReload] = useState(0);
  const inFlight = useRef(false),
    form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    request(root)
      .then((data) => {
        if (active) setServers(data.servers);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [root, request, reload]);
  useEffect(() => {
    if (editing !== null)
      form.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editing]);
  async function act(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function edit(server?: McpServerView) {
    setEditing(server?.id ?? "");
    setName(server?.name ?? "");
    setUrl(server?.url ?? "");
    setTimeoutMs(server?.timeoutMs ?? 15000);
    setSecret("");
    setClearSecret(false);
  }
  return (
    <section className="mcp-panel" aria-label="MCP 服务">
      <div className="mcp-heading">
        <div>
          <h4>MCP 连接</h4>
          <p>Streamable HTTP · 工具发现与调用</p>
        </div>
        <button
          type="button"
          className="ecosystem-primary"
          disabled={busy}
          onClick={() => edit()}
        >
          添加连接
        </button>
      </div>
      <p className="settings-scope">
        {mode === "local"
          ? "连接外部服务，凭据保存在系统保险箱。可以连接当前电脑上的 HTTP MCP 服务。"
          : "连接外部服务，凭据由控制面加密保存，不发给 Runner。普通账号只能连接公网地址，项目协同不使用私人连接。"}{" "}
        每次工具调用都需单独批准，实际在 MCP 服务执行，不受本机沙箱约束。
      </p>
      <p className="ecosystem-scope">
        支持 Bearer
        凭据。stdio、OAuth、资源和提示词暂不支持。连接测试只发现工具，不执行工具调用。
      </p>
      {editing !== null && (
        <form
          ref={form}
          className="mcp-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const data = await request(
                editing ? `${root}/${editing}` : root,
                editing ? "PATCH" : "POST",
                {
                  name,
                  url,
                  timeoutMs,
                  ...(secret ? { secret } : {}),
                  ...(editing && clearSecret ? { clearSecret: true } : {}),
                },
              );
              setServers(data.servers);
              setTools([]);
              setSecret("");
              setFeedback(
                editing
                  ? "连接已更新。配置变化后，旧审批不能调用新目标。"
                  : "已保存，尚未启用。启用后才会在任务里出现。",
              );
              setEditing(null);
            });
          }}
        >
          <label className="settings-field">
            <span>连接名称</span>
            <input
              required
              maxLength={80}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>服务地址</span>
            <input
              type="url"
              required
              maxLength={500}
              placeholder="https://example.com/mcp"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>超时（毫秒）</span>
            <input
              type="number"
              required
              min={500}
              max={120000}
              value={timeoutMs}
              disabled={busy}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
            />
          </label>
          <label className="settings-field">
            <span>
              {editing ? "替换凭据（留空保持不变）" : "Bearer 凭据（可选）"}
            </span>
            <input
              type="password"
              autoComplete="off"
              maxLength={4000}
              value={secret}
              disabled={busy || clearSecret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          {editing && (
            <label className="mcp-clear">
              <input
                type="checkbox"
                checked={clearSecret}
                disabled={busy}
                onChange={(e) => {
                  setClearSecret(e.target.checked);
                  if (e.target.checked) setSecret("");
                }}
              />
              清除已保存的凭据
            </label>
          )}
          <div className="mcp-actions">
            <button type="submit" className="ecosystem-primary" disabled={busy}>
              {busy ? "保存中…" : editing ? "保存修改" : "保存连接"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setSecret("");
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {loading && <p role="status">正在读取 MCP 服务…</p>}
      {!loading && !servers.length && (
        <div className="ecosystem-empty">
          <strong>还没有 MCP 连接</strong>
          <p>添加服务地址，先测试，再启用。</p>
        </div>
      )}
      <ul className="mcp-servers">
        {servers.map((server) => (
          <li key={server.id}>
            <strong>{server.name}</strong>
            <span>{server.url}</span>
            <span>
              {server.enabled ? "已启用" : "未启用"} · 超时 {server.timeoutMs}{" "}
              毫秒 · {server.secretConfigured ? "凭据已安全保存" : "无凭据"}
            </span>
            <div className="mcp-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => edit(server)}
              >
                编辑
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const data = await request(
                      `${root}/${server.id}`,
                      "PATCH",
                      { enabled: !server.enabled },
                    );
                    setServers(data.servers);
                    setFeedback(
                      server.enabled
                        ? "已停用，后续任务不再加载此服务。"
                        : "已启用，工具调用仍需逐次批准。",
                    );
                  })
                }
              >
                {server.enabled ? "停用" : "启用"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setTools([]);
                    const data = await request(
                      `${root}/${server.id}/test`,
                      "POST",
                      {},
                    );
                    setTools(data.tools);
                    const usable = data.tools.filter(
                      (tool: McpToolView) => tool.modelName && tool.inputSchema,
                    ).length;
                    setFeedback(
                      `已连接「${server.name}」：发现 ${data.tools.length} 个工具，其中 ${usable} 个可用于任务。`,
                    );
                  })
                }
              >
                {busy ? "处理中…" : "测试连接"}
              </button>
              <button
                type="button"
                disabled={busy || server.enabled}
                title={server.enabled ? "先停用再移除" : undefined}
                onClick={() =>
                  void act(async () => {
                    const data = await request(
                      `${root}/${server.id}`,
                      "DELETE",
                    );
                    setServers(data.servers);
                    setTools([]);
                    if (editing === server.id) {
                      setEditing(null);
                      setSecret("");
                    }
                    setFeedback("连接已移除，旧审批不能再调用它。");
                  })
                }
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {tools.length > 0 && (
        <ul className="mcp-tools" aria-label="发现的工具">
          {tools.map((tool) => (
            <li key={`${tool.serverId}-${tool.name || tool.skipReason}`}>
              <strong>{tool.name || "未挂载"}</strong>
              <span>{tool.skipReason || tool.description || "无说明"}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div role="alert" className="ecosystem-error">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => setReload((v) => v + 1)}
          >
            重新加载
          </button>
        </div>
      )}
      {feedback && (
        <p role="status" className="ecosystem-feedback">
          {feedback}
        </p>
      )}
    </section>
  );
}
