export type DebugSpanKind =
  | "ui"
  | "control"
  | "model"
  | "tool"
  | "sandbox"
  | "approval"
  | "delivery";

export type DebugSpanStatus = "running" | "ok" | "error" | "cancelled";

/** Timings are monotonic milliseconds from the session trace origin on the recording process. */
export type DebugSpan = {
  id: string;
  parentId?: string;
  sessionId: string;
  runId?: string;
  turnId?: string;
  kind: DebugSpanKind;
  name: string;
  status: DebugSpanStatus;
  startedAtMs: number;
  durationMs?: number;
  wallStartedAt?: string;
  detail?: Record<string, unknown>;
  truncated?: string;
};

export type DebugTraceView = {
  timing?: RunTimingSummary;
  sessionId: string;
  contentEnabled: boolean;
  spans: DebugSpan[];
  dropped: number;
};

const CONTENT_FIELDS = new Set([
  "messages",
  "tools",
  "response",
  "toolCalls",
  "arguments",
  "output",
  "request",
  "text",
  "stdout",
  "stderr",
  "errorText",
]);

/** After a run is terminal, a late runner can no longer replace a still-open approval span. */
export function closeTerminalDebugTrace(trace: DebugTraceView, state: string): DebugTraceView {
  if (state !== "succeeded" && state !== "failed" && state !== "cancelled") return trace;
  const status = state === "failed" ? "error" : "cancelled";
  const error = state === "cancelled" ? "运行已取消" : state === "failed" ? "运行已失败" : "运行已结束，未收到执行端收口";
  return {
    ...trace,
    spans: trace.spans.map((span) => span.status === "running"
      ? { ...span, status, detail: { ...span.detail, error: span.detail?.error ?? error } }
      : span),
  };
}
export function presentDebugTrace(trace: DebugTraceView, contentAllowed: boolean): DebugTraceView {
  if (contentAllowed && trace.contentEnabled) return trace;
  return {
    ...trace,
    contentEnabled: false,
    spans: trace.spans.map((span) => {
      const detail: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(span.detail ?? {})) {
        if (!CONTENT_FIELDS.has(key)) detail[key] = value;
      }
      detail.content = "完整内容未开启";
      return { ...span, detail };
    }),
  };
}

export type RunTimingSummary = {
  runId: string;
  queueMs: number | null;
  preparationMs: number | null;
  elapsedMs: number;
  attempts: number;
  recoveries: number;
  modelMs: number;
  toolMs: number;
  approvalMs: number;
  contextMs: number;
  modelCallsObserved: number;
  modelTtftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  partial: boolean;
};
/** Runner durations are summed only within spans, never by subtracting different host clocks. */
export function summarizeRunTiming(input: { runId: string; createdAt: string; startedAt?: string; firstClaimAt?: string; endAt: string; attempts: number; recoveries: number; traces: DebugTraceView[] }): RunTimingSummary {
  const delta = (end: string | undefined, start: string | undefined) => {
    const n = Date.parse(end ?? "") - Date.parse(start ?? "");
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const spans = input.traces.flatMap(t => t.spans);
  const total = (kind: string, name?: string) => spans.filter(s => s.kind === kind && (!name || s.name === name)).reduce((n, s) => n + (Number.isFinite(s.durationMs) ? Math.max(0, s.durationMs!) : 0), 0);
  const models = spans.filter(s => s.kind === "model");
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  const tokens = (key: string) => {
    const values = models.map(s => number((s.detail?.usage as Record<string, unknown> | undefined)?.[key])).filter((n): n is number => n !== null);
    return values.length ? values.reduce((n, value) => n + value, 0) : null;
  };
  return { runId: input.runId, queueMs: delta(input.firstClaimAt, input.createdAt), preparationMs: delta(input.startedAt, input.firstClaimAt), elapsedMs: delta(input.endAt, input.createdAt) ?? 0,
    attempts: input.attempts, recoveries: input.recoveries, modelMs: total("model"), toolMs: total("tool"), approvalMs: total("approval"), contextMs: total("control", "context_assembly"),
    modelCallsObserved: models.length, modelTtftMs: number(models[0]?.detail?.ttftMs), inputTokens: tokens("prompt_tokens"), outputTokens: tokens("completion_tokens"),
    partial: input.traces.length < input.attempts || input.traces.some(t => t.dropped > 0 || t.spans.some(s => s.status === "running")),
  };
}
