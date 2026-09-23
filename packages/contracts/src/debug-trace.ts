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
