/**
 * Model routing for the gateway: ordered provider candidates (primary channel, then standby channels by
 * rank), a per-provider circuit breaker, failover before any byte reaches the runner, and a real output
 * cap (the same per-channel limit drives the upstream max_tokens, the budget reservation and a streaming
 * cutoff for providers that overrun it).
 */
export type Provider = { id?: string; baseUrl: string; model: string; apiKey: string; maxOutputTokens?: number };
export type Attempt = { provider: string; status: number | "network" | "timeout" | "circuit_open"; ms: number };

export const DEFAULT_MAX_OUTPUT = 4096;
export const outputCap = (p: Pick<Provider, "maxOutputTokens">) =>
  Math.max(1, Math.min(32768, Math.floor(Number(p.maxOutputTokens) || DEFAULT_MAX_OUTPUT)));
export const providerKey = (p: Provider) => p.id || `${p.baseUrl}#${p.model}`;

/**
 * Statuses that say "this provider, not this request" — another provider may succeed. 400/404/413/422
 * are request problems and would fail everywhere, so they are returned as-is.
 */
export function retryable(status: number) {
  return status === 401 || status === 402 || status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Consecutive-failure breaker: opens after `threshold` failures for `openMs`, then lets one probe through. */
export class CircuitBreaker {
  private state = new Map<string, { failures: number; openUntil: number }>();
  constructor(
    private readonly threshold = 3,
    private readonly openMs = 30_000,
  ) {}
  isOpen(key: string, now = Date.now()) {
    return (this.state.get(key)?.openUntil ?? 0) > now;
  }
  success(key: string) {
    this.state.delete(key);
  }
  failure(key: string, now = Date.now()) {
    const s = this.state.get(key) ?? { failures: 0, openUntil: 0 };
    s.failures++;
    if (s.failures >= this.threshold) s.openUntil = now + this.openMs;
    this.state.set(key, s);
  }
  /** Closed providers first (in configured order); open ones stay as a last resort. */
  order<T extends Provider>(providers: T[], now = Date.now()): T[] {
    return [...providers.filter((p) => !this.isOpen(providerKey(p), now)), ...providers.filter((p) => this.isOpen(providerKey(p), now))];
  }
  snapshot(now = Date.now()) {
    return [...this.state].map(([key, s]) => ({ key, failures: s.failures, open: s.openUntil > now }));
  }
}

/** Body sent upstream: model and output cap belong to the provider, not the runner. */
export function upstreamBody(body: Record<string, unknown>, provider: Provider) {
  const cap = outputCap(provider);
  return {
    ...body,
    n: 1,
    max_completion_tokens: undefined,
    model: provider.model,
    max_tokens: Math.max(1, Math.min(Number(body.max_tokens) || cap, cap)),
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type RouteResult =
  | { ok: true; response: Response; provider: Provider; attempts: Attempt[] }
  | { ok: false; status: number; attempts: Attempt[]; response?: Response };

/**
 * Tries providers in order until one answers with a non-retryable status. Streaming calls fail over on
 * headers only (time to headers bounded by `headersTimeoutMs`), so nothing has been sent to the runner yet.
 */
export async function route(opts: {
  providers: Provider[];
  body: Record<string, unknown>;
  fetch: FetchLike;
  breaker: CircuitBreaker;
  signal: AbortSignal;
  headersTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<RouteResult> {
  const attempts: Attempt[] = [];
  const list = opts.breaker.order(opts.providers);
  let last: Response | undefined;
  for (const [i, provider] of list.entries()) {
    if (opts.signal.aborted) break;
    const key = providerKey(provider);
    const t0 = Date.now();
    const headers = new AbortController();
    const timer = setTimeout(() => headers.abort(), opts.headersTimeoutMs ?? 30_000);
    try {
      const response = await opts.fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(upstreamBody(opts.body, provider)),
        signal: AbortSignal.any([opts.signal, headers.signal, AbortSignal.timeout(opts.totalTimeoutMs ?? 90_000)]),
      });
      clearTimeout(timer);
      attempts.push({ provider: key, status: response.status, ms: Date.now() - t0 });
      if (response.ok) {
        opts.breaker.success(key);
        return { ok: true, response, provider, attempts };
      }
      if (!retryable(response.status)) {
        // The request itself was rejected; the provider is healthy.
        opts.breaker.success(key);
        return { ok: false, status: response.status, attempts, response };
      }
      opts.breaker.failure(key);
      if (i < list.length - 1) await response.body?.cancel().catch(() => {});
      last = response;
    } catch {
      clearTimeout(timer);
      if (opts.signal.aborted) {
        attempts.push({ provider: key, status: "network", ms: Date.now() - t0 });
        break; // the runner went away; do not burn other providers
      }
      attempts.push({ provider: key, status: headers.signal.aborted ? "timeout" : "network", ms: Date.now() - t0 });
      opts.breaker.failure(key);
    }
  }
  return { ok: false, status: last?.status ?? 502, attempts, ...(last ? { response: last } : {}) };
}

/** Token estimate without a tokenizer: CJK characters ~1 token each, other text ~4 characters per token. */
export function estimateTokens(text: string) {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * Meters an OpenAI-compatible SSE stream: captures provider usage, estimates output tokens from deltas
 * (content, reasoning, tool calls) and reports when the output cap is clearly exceeded.
 */
export class OutputMeter {
  usage: { prompt_tokens: number; completion_tokens: number; [k: string]: unknown } | undefined;
  estimatedOutput = 0;
  private pending = "";
  private readonly decoder = new TextDecoder();
  constructor(readonly cap: number, readonly slack = Math.ceil(cap * 0.25) + 64) {}
  /** Feeds raw bytes; returns true once the estimated output exceeds the cap plus slack. */
  push(chunk: Uint8Array) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (json.usage) this.usage = json.usage;
        for (const choice of json.choices ?? []) {
          const d = choice.delta ?? {};
          let text = (typeof d.content === "string" ? d.content : "") + (typeof d.reasoning_content === "string" ? d.reasoning_content : "");
          for (const t of d.tool_calls ?? []) text += (t.function?.name ?? "") + (t.function?.arguments ?? "");
          if (text) this.estimatedOutput += estimateTokens(text);
        }
      } catch {
        /* partial or non-JSON frame */
      }
    }
    if (this.pending.length > 2 * 1024 * 1024) throw Error("Provider SSE frame too large");
    return this.exceeded;
  }
  get exceeded() {
    return this.estimatedOutput > this.cap + this.slack;
  }
}

/** Closing frames for a stream cut at the output cap: finish_reason "length", like a provider would send. */
export const capFrames = () =>
  new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);

/** Usage to settle when the provider sent none (stream cut, aborted or dropped): estimated, never zero output. */
export function estimatedUsage(requestBody: unknown, meter: OutputMeter) {
  const messages = (requestBody as { messages?: unknown })?.messages;
  return { prompt_tokens: estimateTokens(JSON.stringify(messages ?? "")), completion_tokens: Math.max(1, meter.estimatedOutput), estimated: true };
}
