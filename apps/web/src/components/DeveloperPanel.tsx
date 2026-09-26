import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DebugSpan, DebugSpanStatus, DebugTraceView } from "../types";

const EMPTY: DebugTraceView = {
  sessionId: "",
  contentEnabled: false,
  spans: [],
  dropped: 0,
};

const STATUS_LABEL: Record<DebugSpanStatus, string> = {
  running: "进行中",
  ok: "完成",
  error: "失败",
  cancelled: "已取消",
};

export function DeveloperPanel({
  sessionKey,
  url,
  writable,
  contentChoice,
}: {
  sessionKey: string;
  url: string;
  writable: boolean;
  contentChoice?: { enabled: boolean; onChange: (enabled: boolean) => void; label?: string };
}) {
  const [view, setView] = useState<DebugTraceView>(EMPTY);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "failed" | "running">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const ticket = useRef(0);

  useEffect(() => {
    ticket.current += 1;
    setView(EMPTY);
    setSelectedId(null);
    setError("");
    setNotice("");
  }, [sessionKey]);

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    const load = async () => {
      const current = ticket.current;
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        const data = (await response.json()) as DebugTraceView & { error?: string };
        if (stopped || current !== ticket.current) return;
        if (!response.ok) {
          setError(typeof data.error === "string" ? data.error : "调试记录不可用");
          setView(EMPTY);
          return;
        }
        setError("");
        setView(data);
      } catch (err) {
        if (stopped || current !== ticket.current) return;
        setError(err instanceof Error ? err.message : "调试记录不可用");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [url, sessionKey]);

  const spans = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.spans.filter((span) => {
      if (filter === "failed" && span.status !== "error" && span.status !== "cancelled") return false;
      if (filter === "running" && span.status !== "running") return false;
      if (!q) return true;
      const blob = `${span.name} ${span.kind} ${span.id} ${JSON.stringify(span.detail ?? {})}`.toLowerCase();
      return blob.includes(q);
    });
  }, [view.spans, query, filter]);

  const selected = spans.find((span) => span.id === selectedId) ?? spans.at(-1) ?? null;
  const origin = spans.reduce((min, span) => Math.min(min, span.startedAtMs), spans[0]?.startedAtMs ?? 0);
  const horizon = spans.reduce((max, span) => Math.max(max, span.startedAtMs + (span.durationMs ?? 0)), origin + 1);
  const width = Math.max(1, horizon - origin);
  const problems = view.spans.filter((span) => span.status === "error" || span.status === "cancelled");

  useEffect(() => {
    if (!autoScroll) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [autoScroll, spans.length, view.spans.length]);

  const post = async (body: { content?: boolean; clear?: boolean }) => {
    if (!writable) return;
    const current = ticket.current;
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as DebugTraceView & { error?: string };
    if (current !== ticket.current) return;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "无法更新调试视图");
    setView(data);
  };

  const exportTrace = () => {
    const blob = new Blob([JSON.stringify(view, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `debug-${sessionKey || "session"}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="developer-panel flex h-full min-h-0 flex-col bg-panel text-ink-800" aria-label="开发者">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-300 px-3 py-2">
        <input
          aria-label="搜索调用"
          className="input min-w-0 flex-1 text-xs"
          placeholder="搜索名称、类型或编号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="筛选调用"
          className="input text-xs"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">全部</option>
          <option value="failed">失败</option>
          <option value="running">进行中</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-ink-600">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          自动滚动
        </label>
        <button type="button" className="btn-ghost text-xs" onClick={() => void exportTrace()}>
          导出
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={!writable}
          onClick={() => void post({ clear: true }).catch((err: unknown) => setNotice(err instanceof Error ? err.message : "清空失败"))}
        >
          清空视图
        </button>
      </div>
      {view.timing && <section aria-label="运行耗时概览" className="grid grid-cols-2 gap-2 border-b border-ink-300 p-3 text-xs sm:grid-cols-4">
        {Object.entries({ "排队": view.timing.queueMs, "准备": view.timing.preparationMs, "整体经过": view.timing.elapsedMs, "模型首字": view.timing.modelTtftMs,
          "模型累计": view.timing.modelMs, "工具累计": view.timing.toolMs, "审批累计": view.timing.approvalMs, "上下文组装": view.timing.contextMs }).map(([label, ms]) =>
          <div key={label}><div className="text-ink-500">{label}</div><strong>{ms === null ? "未采集" : `${(ms / 1000).toFixed(2)} s`}</strong></div>)}
        <p className="col-span-2 sm:col-span-4 text-ink-500">尝试 {view.timing.attempts} 次 · 自动恢复 {view.timing.recoveries} 次 · 已观测模型调用 {view.timing.modelCallsObserved} 次 · 输入/输出 token {view.timing.inputTokens ?? "未知"}/{view.timing.outputTokens ?? "未知"}。整体时间按控制面计时，不含浏览器往返。阶段可能重叠，不应相加。{view.timing.partial ? "记录不完整或仍在执行。" : ""}</p>
      </section>}
      <details className="border-b border-ink-300 px-3 py-2 text-xs text-ink-600"><summary className="cursor-pointer">记录范围与隐私</summary><p className="py-2">
        {writable
          ? view.contentEnabled
            ? "完整内容已开启，只留在本机服务进程内存。仍会去掉密钥；清空视图不删除执行结果。"
            : "完整内容默认关闭。开启后只留在本机服务进程内存，仍会去掉密钥；清空视图不删除执行结果。"
          : "这是远端执行快照。正文默认不采集；只有这次运行显式开启，并且你本来就能查看该运行时，才会返回脱敏后的请求和响应。没有采集到的耗时和沙箱显示为未采集。"}
        <label className="ml-2 inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={view.contentEnabled}
            disabled={!writable}
            onChange={(event) => void post({ content: event.target.checked }).catch((err: unknown) => setNotice(err instanceof Error ? err.message : "无法切换内容"))}
          />
          记录完整内容
        </label>
        {contentChoice && (
          <label className="ml-2 inline-flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={contentChoice.label ?? "下次运行记录正文"}
              checked={contentChoice.enabled}
              onChange={(event) => contentChoice.onChange(event.target.checked)}
            />
            {contentChoice.label ?? "下次运行记录正文"}
          </label>
        )}
      </p></details>
      {(error || notice) && <p role="alert" className="px-3 py-1 text-xs text-danger">{error || notice}</p>}
      {view.dropped > 0 && <p className="px-3 py-1 text-xs text-ink-600">已丢弃最早的 {view.dropped} 条，以控制保留条数和总体积。</p>}
      <div ref={listRef} className="min-h-[120px] min-w-0 flex-1 overflow-auto" aria-label="调用列表">
        {!spans.length && <p className="px-3 py-4 text-xs text-ink-600">这一对话还没有采集到调用。</p>}
        <ul className="text-xs">
          {spans.map((span) => (
            <li key={span.id}>
              <button
                type="button"
                className={`grid w-full grid-cols-[4.5rem_4.2rem_minmax(0,1fr)] items-baseline gap-1 px-2 py-1 text-left ${selected?.id === span.id ? "bg-accent-soft" : "hover:bg-ink-200"}`}
                onClick={() => setSelectedId(span.id)}
              >
                <span>{STATUS_LABEL[span.status]}</span>
                <span className="font-mono">{span.durationMs === undefined ? "未采集" : `${Math.round(span.durationMs * 100) / 100} ms`}</span>
                <span className="truncate">{span.kind} · {span.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {spans.length > 0 && (
        <details className="shrink-0 border-t border-ink-300 px-3 py-1" aria-label="调用时间线">
          <summary className="cursor-pointer text-xs text-ink-600">时间线</summary>
          <div className="max-h-28 overflow-auto py-1">
            {spans.map((span) => (
              <div key={`${span.id}:bar`} className="mb-1 grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
                <span className="truncate text-xs text-ink-600">{span.name}</span>
                <div className="h-2 bg-ink-200">
                  <div
                    className={span.status === "error" ? "h-2 bg-danger" : "h-2 bg-accent"}
                    style={{
                      marginLeft: `${((span.startedAtMs - origin) / width) * 100}%`,
                      width: `${Math.max(1, ((span.durationMs ?? 0) / width) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <section className="min-h-0 min-w-0 flex-1 overflow-auto border-t border-ink-300 px-2 py-2" aria-label="调用详情">
        {!selected && <p className="px-1 text-xs text-ink-600">选择一次调用查看脱敏详情。</p>}
        {selected && <SpanDetail span={selected} onCopy={(text) => void navigator.clipboard.writeText(text).then(() => setNotice("已复制这一段")).catch(() => setNotice("复制失败"))} />}
      </section>
      <section className="max-h-14 shrink-0 overflow-auto border-t border-ink-300 px-3 py-1" aria-label="错误">
        <p className="mb-1 text-xs text-ink-600">错误</p>
        {!problems.length && <p className="text-xs text-ink-500">没有失败或取消记录。</p>}
        {problems.map((span) => (
          <button key={`err:${span.id}`} type="button" className="block w-full truncate text-left text-xs text-danger" onClick={() => setSelectedId(span.id)}>
            {STATUS_LABEL[span.status]} · {span.kind} · {span.name}
          </button>
        ))}
      </section>
    </div>
  );
}

function SpanDetail({ span, onCopy }: { span: DebugSpan; onCopy: (text: string) => void }) {
  const detail = span.detail ?? {};
  const request = asRecord(detail.request);
  const body = asRecord(request?.body);
  const messages = body?.messages;
  const tools = body?.tools;
  const responseText = "response" in detail ? detail.response : undefined;
  const executionResult = detail.output;
  const toolCalls = detail.toolCalls;
  const overview = [
    ["状态", STATUS_LABEL[span.status]],
    ["耗时", span.durationMs === undefined ? "未采集" : `${Math.round(span.durationMs * 100) / 100} ms`],
    ["TTFT", formatOptionalMs(detail.ttftMs)],
    ["用量", formatUsage(detail.usage)],
    ["方法", textOrMissing(request?.method)],
    ["HTTP 状态", request?.httpStatus === null || request?.httpStatus === undefined ? "未采集" : String(request.httpStatus)],
    ["URL", textOrMissing(request?.url)],
    ["结束原因", detail.finishReason === null || detail.finishReason === undefined ? "未采集" : String(detail.finishReason)],
  ];
  const environment = [
    ["模型", textOrMissing(detail.model)],
    ["提供商", textOrMissing(detail.provider)],
    ["请求沙箱", textOrMissing(detail.sandboxRequested)],
    ["有效沙箱", textOrMissing(detail.sandboxEffective)],
    ["沙箱后端", textOrMissing(detail.sandboxBackend)],
    ["网络", detail.network === undefined ? "未采集" : String(detail.network)],
    ["截断", span.truncated ? span.truncated : "无"],
  ];
  return (
    <div className="min-w-0">
      <p className="mb-1 truncate px-1 text-xs text-ink-600">{span.kind} · {span.name}</p>
      <DetailBlock title="概览" open copyText={overview.map(([label, value]) => `${label}: ${value}`).join("\n")} onCopy={onCopy}>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
          {overview.map(([label, value]) => (
            <div key={label} className={label === "URL" ? "col-span-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2" : "min-w-0"}>
              <dt className="text-ink-500">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </DetailBlock>
      <DetailBlock title="请求" copyText={JSON.stringify(messages ?? "未采集", null, 2)} onCopy={onCopy}>
        <p className="mb-1 text-ink-500">{messages === undefined ? "未采集" : Array.isArray(messages) && messages.length === 0 ? "空" : `${Array.isArray(messages) ? messages.length : 1} 条消息`}</p>
        {messages !== undefined && <Pretty text={messages} />}
        <details className="mt-2">
          <summary className="cursor-pointer text-ink-600">工具定义</summary>
          <div className="mt-1 flex justify-end">
            <CopyButton onClick={() => onCopy(JSON.stringify(tools ?? "未采集", null, 2))} />
          </div>
          {tools === undefined || tools === null ? <p>未采集</p> : <Pretty text={tools} />}
        </details>
      </DetailBlock>
      <DetailBlock title="响应" open copyText={[responseCopy(responseText, toolCalls), executionResult === undefined ? "" : `执行结果:\n${typeof executionResult === "string" ? executionResult : JSON.stringify(executionResult, null, 2)}`].filter(Boolean).join("\n")} onCopy={onCopy}>
        <p className="mb-1 text-ink-500">正文</p>
        <Pretty text={responseText === undefined ? "未采集" : responseText === "" ? "空" : responseText} />
        <p className="mb-1 mt-2 text-ink-500">工具调用</p>
        <Pretty text={toolCalls === undefined ? "未采集" : toolCalls} />
        {executionResult !== undefined && (
          <>
            <p className="mb-1 mt-2 text-ink-500">执行结果</p>
            <Pretty text={executionResult} />
          </>
        )}
      </DetailBlock>
      <DetailBlock title="执行环境" copyText={environment.map(([label, value]) => `${label}: ${value}`).join("\n")} onCopy={onCopy}>
        <dl className="grid grid-cols-1 gap-1">
          {environment.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-ink-500">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </DetailBlock>
    </div>
  );
}

function DetailBlock({
  title,
  open = false,
  copyText,
  onCopy,
  children,
}: {
  title: string;
  open?: boolean;
  copyText: string;
  onCopy: (text: string) => void;
  children: ReactNode;
}) {
  return (
    <details open={open} className="mb-2 rounded-btn border border-ink-300 px-2 py-1 text-xs">
      <summary className="flex cursor-pointer items-center gap-2">
        <span className="min-w-0 flex-1">{title}</span>
        <CopyButton onClick={() => onCopy(copyText)} />
      </summary>
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn-ghost shrink-0 text-xs"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      复制
    </button>
  );
}

function Pretty({ text }: { text: unknown }) {
  const value = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  return <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{value}</pre>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOrMissing(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "未采集";
  return value;
}

function formatOptionalMs(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "未采集";
}

function formatUsage(value: unknown): string {
  const usage = asRecord(value);
  if (!usage) return "未采集";
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens;
  if (typeof prompt !== "number" && typeof completion !== "number") return "未采集";
  return `输入 ${typeof prompt === "number" ? prompt : "未采集"} · 输出 ${typeof completion === "number" ? completion : "未采集"} · 合计 ${typeof total === "number" ? total : "未采集"}`;
}

function responseCopy(response: unknown, toolCalls: unknown): string {
  return JSON.stringify({ response: response === undefined ? "未采集" : response, toolCalls: toolCalls === undefined ? "未采集" : toolCalls }, null, 2);
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "未采集";
  return `${Math.round(value)} ms`;
}
