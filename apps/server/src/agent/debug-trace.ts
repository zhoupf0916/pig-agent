import { presentDebugTrace, type DebugSpan, type DebugTraceView } from "@pig-agent/contracts";

export { presentDebugTrace };

/** Match a secret field name, not a usage counter such as prompt_tokens. */
const SECRET_KEY = /(?:^|[_.-])(?:authorization|cookie|set-cookie|api[-_]?key|token|password|secret)(?:$|[_.-])/i;
const MAX_TEXT = 4_000;
const MAX_OBJECT_KEYS = 40;
export const DEBUG_TRACE_LIMITS = {
  maxSpans: 200,
  maxSessions: 32,
  maxSpanBytes: 65_536,
  maxTotalBytes: 2_097_152,
} as const;

const traces = new Map<string, { origin: number; content: boolean; spans: DebugSpan[]; dropped: number; touched: number }>();
const listeners = new Set<(sessionId: string) => void>();

export function subscribeDebugSpans(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function redactDebug(value: unknown, depth = 0, notes?: string[]): unknown {
  if (depth > 6) {
    notes?.push("嵌套超过 6 层");
    return "[truncated depth]";
  }
  if (typeof value === "string") {
    if (value.length > MAX_TEXT) notes?.push(`文本超过 ${MAX_TEXT} 字符`);
    return redactDebugText(value);
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 40) notes?.push("数组超过 40 项");
    return value.slice(0, 40).map((item) => redactDebug(item, depth + 1, notes));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) notes?.push(`对象字段超过 ${MAX_OBJECT_KEYS} 项`);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactDebug(item, depth + 1, notes);
  }
  return out;
}

export function redactDebugText(value: string): string {
  const secretEnv = /(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token|authorization)(?:_|$)/i;
  const redacted = value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:Proxy-)?Authorization:\s*Basic\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(?:Set-)?Cookie:\s*[^\r\n]+/gi, (header) => header.toLowerCase().startsWith("set-") ? "Set-Cookie: [redacted]" : "Cookie: [redacted]")
    .replace(/X-API-Key:\s*\S+/gi, "X-API-Key: [redacted]")
    .replace(/((?:^|[\s;"'])password\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/("(?:password|secret|token|api[_-]?key|access[_-]?token|authorization)"\s*:\s*")([^"\\]*)(")/gi, "$1[redacted]$3")
    .replace(/(^|[\s;])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([^\s#]+)/g, (full, lead: string, name: string, eq: string) => (
      secretEnv.test(name) ? `${lead}${name}${eq}[redacted]` : full
    ));
  return redacted.length > MAX_TEXT ? `${redacted.slice(0, MAX_TEXT)}…[truncated]` : redacted;
}

function bucket(sessionId: string) {
  let trace = traces.get(sessionId);
  if (!trace) {
    trace = { origin: performance.now(), content: false, spans: [], dropped: 0, touched: performance.now() };
    traces.set(sessionId, trace);
  }
  trace.touched = performance.now();
  return trace;
}

function spanBytes(span: DebugSpan): number {
  return Buffer.byteLength(JSON.stringify(span));
}

function joinNote(current: string | undefined, extra: string): string {
  if (!current) return extra;
  return current.includes(extra) ? current : `${current}；${extra}`;
}

function fitSpanBytes(span: DebugSpan): DebugSpan {
  if (spanBytes(span) <= DEBUG_TRACE_LIMITS.maxSpanBytes) return span;
  const note = `单条超过 ${DEBUG_TRACE_LIMITS.maxSpanBytes} 字节`;
  const detail = { ...(span.detail ?? {}) };
  let next: DebugSpan = { ...span, detail, truncated: joinNote(span.truncated, note) };
  for (const key of Object.keys(detail)) {
    delete detail[key];
    next = { ...span, detail: { ...detail }, truncated: joinNote(span.truncated, note) };
    if (spanBytes(next) <= DEBUG_TRACE_LIMITS.maxSpanBytes) return next;
  }
  next = { ...span, detail: undefined, truncated: joinNote(span.truncated, note) };
  return spanBytes(next) <= DEBUG_TRACE_LIMITS.maxSpanBytes ? next : { ...next, truncated: note.slice(0, 200) };
}

function totalBytes(): number {
  let sum = 0;
  for (const trace of traces.values()) {
    for (const span of trace.spans) sum += spanBytes(span);
  }
  return sum;
}

function oldestSession(exceptId: string) {
  let found: [string, (typeof traces extends Map<string, infer V> ? V : never)] | undefined;
  for (const entry of traces) {
    if (entry[0] === exceptId) continue;
    if (!found || entry[1].touched < found[1].touched) found = entry;
  }
  return found;
}

function enforceTraceLimits(exceptId: string): void {
  while (traces.size > DEBUG_TRACE_LIMITS.maxSessions) {
    const oldest = oldestSession(exceptId);
    if (!oldest) break;
    traces.delete(oldest[0]);
  }
  while (totalBytes() > DEBUG_TRACE_LIMITS.maxTotalBytes) {
    const oldest = oldestSession(exceptId);
    if (!oldest) {
      const current = traces.get(exceptId);
      if (!current || current.spans.length <= 1) break;
      current.spans.shift();
      current.dropped += 1;
      continue;
    }
    if (oldest[1].spans.length > 1) {
      oldest[1].spans.shift();
      oldest[1].dropped += 1;
    } else {
      traces.delete(oldest[0]);
    }
  }
}

export function setDebugContent(sessionId: string, enabled: boolean): void {
  bucket(sessionId).content = enabled;
}

export function debugContentEnabled(sessionId: string): boolean {
  return traces.get(sessionId)?.content === true;
}

export function clearDebugView(sessionId: string): void {
  const trace = traces.get(sessionId);
  if (!trace) return;
  trace.spans = [];
  trace.dropped = 0;
}

export function dropDebugSession(sessionId: string): void {
  traces.delete(sessionId);
}

export function finishDebugSpan(sessionId: string, id: string, status: DebugSpan["status"], extra?: Record<string, unknown>): boolean {
  const trace = traces.get(sessionId);
  const current = trace?.spans.find((span) => span.id === id);
  if (!current || !trace) return false;
  const durationMs = Math.max(0, Math.round(performance.now() - trace.origin - current.startedAtMs));
  recordDebugSpan({
    ...current,
    status,
    durationMs,
    detail: { ...current.detail, ...extra },
  });
  return true;
}

export function cancelRunningDebugSpans(sessionId: string, error = "已取消"): number {
  const running = traces.get(sessionId)?.spans.filter((span) => span.status === "running") ?? [];
  for (const span of running) finishDebugSpan(sessionId, span.id, "cancelled", { error });
  return running.length;
}

export function recordDebugSpan(span: DebugSpan, monoStart?: number): void {
  const trace = bucket(span.sessionId);
  const startedAtMs = monoStart === undefined ? span.startedAtMs : Math.max(0, Math.round(monoStart - trace.origin));
  const notes: string[] = [];
  const detail = span.detail ? redactDebug(span.detail, 0, notes) as Record<string, unknown> : undefined;
  const truncated = span.truncated ?? (notes.length ? [...new Set(notes)].join("；") : undefined);
  const next = fitSpanBytes({ ...span, startedAtMs, detail, ...(truncated ? { truncated } : {}) });
  const index = trace.spans.findIndex((item) => item.id === span.id);
  if (index >= 0) trace.spans[index] = next;
  else {
    trace.spans.push(next);
    if (trace.spans.length > DEBUG_TRACE_LIMITS.maxSpans) {
      trace.spans.shift();
      trace.dropped += 1;
    }
  }
  enforceTraceLimits(span.sessionId);
  for (const listener of listeners) listener(span.sessionId);
}

export function readDebugTrace(sessionId: string): DebugTraceView {
  const trace = traces.get(sessionId);
  return {
    sessionId,
    contentEnabled: trace?.content === true,
    spans: trace ? [...trace.spans] : [],
    dropped: trace?.dropped ?? 0,
  };
}

export function debugDetail(sessionId: string, detail: Record<string, unknown>, content: Record<string, unknown>): Record<string, unknown> {
  if (!debugContentEnabled(sessionId)) return { ...detail, content: "完整内容未开启" };
  return { ...detail, ...content };
}
