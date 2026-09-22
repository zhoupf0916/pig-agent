import { useEffect, useState } from "react";

type Manifest = {
  format: string;
  id: string;
  name: string;
  version: string;
  description: string;
  skills: { id: string; name: string; body: string; description: string }[];
  experts: {
    id: string;
    name: string;
    instruction: string;
    description: string;
  }[];
};
type Installed = { manifest: Manifest; enabled: boolean };
async function request(path: string, method = "GET", body?: unknown) {
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
export function ExtensionsPanel() {
  const [plugins, setPlugins] = useState<Installed[]>([]),
    [draft, setDraft] = useState<Manifest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    request("/api/plugins")
      .then((d) => setPlugins(d.plugins))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="插件管理">
      <p className="settings-scope">
        插件把专家和技能整理成可复用的工作方法。先预览内容，再导入启用；不会自动执行任务。插件操作立即保存，无需点击底部“保存”。
      </p>
      <label className="settings-field">
        <span>导入插件包</span>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file)
              void act(async () => {
                setDraft(null);
                if (file.size > 600000) throw Error("文件不能超过 600 KB");
                const d = await request(
                  "/api/plugins/preview",
                  "POST",
                  JSON.parse(await file.text()),
                );
                setDraft(d.manifest);
              });
          }}
        />
        <small>
          支持 pig-plugin-v1 JSON 专家/技能包。脚本、MCP
          工具和市场安装尚不支持。
        </small>
      </label>
      {draft && (
        <section className="settings-details" aria-label="插件预览">
          <h4>
            {draft.name} <small>{draft.version}</small>
          </h4>
          <p>{draft.description}</p>
          <details>
            <summary>
              检查 {draft.experts.length} 个专家、{draft.skills.length} 个技能
            </summary>
            {draft.experts.map((e) => (
              <article key={e.id}>
                <h4>{e.name}</h4>
                <pre className="settings-code">{e.instruction}</pre>
              </article>
            ))}
            {draft.skills.map((s) => (
              <article key={s.id}>
                <h4>{s.name}</h4>
                <pre className="settings-code">{s.body}</pre>
              </article>
            ))}
          </details>
          <p className="settings-note">
            启用后，这些指令可能随任务发送给当前模型提供商。请检查来源与内容。
          </p>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const d = await request("/api/plugins", "POST", draft);
                setPlugins(d.plugins);
                setDraft(null);
                setFeedback("插件已导入，尚未启用。");
              })
            }
          >
            导入，暂不启用
          </button>{" "}
          <button
            className="btn-quiet"
            onClick={() => setDraft(null)}
            disabled={busy}
          >
            取消
          </button>
        </section>
      )}
      <h4>已安装插件</h4>
      {loading && (
        <p role="status" className="settings-note">
          正在读取已安装插件…
        </p>
      )}
      {!loading && !plugins.length && (
        <p className="settings-note">
          还没有插件。导入团队提供的工作方法包即可开始。
        </p>
      )}
      <ul className="settings-skill-list">
        {plugins.map((p) => (
          <li key={p.manifest.id}>
            <strong>
              {p.manifest.name} · {p.manifest.version}
            </strong>
            <span>{p.manifest.description}</span>
            <span>
              {p.manifest.experts.length} 专家 · {p.manifest.skills.length} 技能
              · {p.enabled ? "已启用" : "已停用"}
            </span>
            <details>
              <summary>查看指令</summary>
              {[
                ...p.manifest.skills.map((s) => ({
                  name: s.name,
                  text: s.body,
                })),
                ...p.manifest.experts.map((e) => ({
                  name: e.name,
                  text: e.instruction,
                })),
              ].map((x, i) => (
                <div key={i}>
                  <strong>{x.name}</strong>
                  <pre className="settings-code">{x.text}</pre>
                </div>
              ))}
            </details>
            <div>
              <button
                className="btn-quiet"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await request(
                      `/api/plugins/${p.manifest.id}`,
                      "PATCH",
                      { enabled: !p.enabled },
                    );
                    setPlugins(d.plugins);
                    setFeedback(
                      p.enabled
                        ? "已停用。后续任务不再加载此插件；运行中的任务不受影响。"
                        : "已启用，可在专家目录选择或由 Pig 加载技能。",
                    );
                  })
                }
              >
                {p.enabled ? "停用" : "启用"}
              </button>{" "}
              <button
                className="btn-quiet"
                disabled={busy || p.enabled}
                title={p.enabled ? "先停用再移除" : undefined}
                onClick={() =>
                  void act(async () => {
                    const d = await request(
                      `/api/plugins/${p.manifest.id}`,
                      "DELETE",
                    );
                    setPlugins(d.plugins);
                    setFeedback("已移除插件，可重新导入。历史任务保留。");
                  })
                }
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
