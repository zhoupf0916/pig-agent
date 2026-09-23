import { isBlockedEgressAddress, isLoopbackAddress } from "@pig-agent/contracts";

export const MCP_RESPONSE_BYTE_LIMIT = 1_048_576;
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { SsrfError, createPinnedLookup, parseHttpUrl, resolvePublicIps, type LookupFn } from "./ssrf.ts";

export type McpEgressOptions = {
  /** Desktop may opt in to loopback. Cloud tenants must leave this false. */
  allowLoopback?: boolean;
  lookup?: LookupFn;
  connect?: typeof connectPinnedMcp;
  /**
   * Bounds DNS and the HTTP exchange. The SDK replaces requestInit.signal
   * with its own controller, so the deadline has to be applied in this fetch.
   */
  deadline?: AbortSignal;
};

function linkedSignal(left: AbortSignal | null | undefined, right: AbortSignal | null | undefined): AbortSignal | undefined {
  if (left && right) return AbortSignal.any([left, right]);
  return left ?? right ?? undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function bounded<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export function parseMcpUrl(raw: string, allowLoopback = false): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new SsrfError("MCP 地址无效"); }
  if (url.username || url.password) throw new SsrfError("MCP 地址不能携带用户信息");
  const host = hostOf(url);
  if (allowLoopback && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("MCP 只允许 http 或 https");
    return url;
  }
  return parseHttpUrl(raw);
}

export function assertMcpAddresses(ips: string[], options: McpEgressOptions = {}): void {
  for (const ip of ips) {
    if (options.allowLoopback && isLoopbackAddress(ip)) continue;
    if (isBlockedEgressAddress(ip)) throw new SsrfError("MCP 目标地址被拒绝");
  }
}

export async function pinMcpTarget(rawUrl: string, options: McpEgressOptions = {}): Promise<{ url: URL; ips: string[] }> {
  const url = parseMcpUrl(rawUrl, options.allowLoopback === true);
  const host = hostOf(url);
  const ips = options.allowLoopback && (host === "localhost" || isLoopbackAddress(host))
    ? [host === "localhost" ? "127.0.0.1" : host]
    : await resolvePublicIps(host, options.lookup);
  assertMcpAddresses(ips, options);
  return { url, ips };
}

export function connectPinnedMcp(
  requestUrl: URL,
  ips: string[],
  init: { method?: string; headers?: Headers; body?: string; signal?: AbortSignal | null },
): Promise<Response> {
  const hostname = hostOf(requestUrl);
  const request = requestUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  headers.set("host", requestUrl.host);
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: requestUrl.protocol,
      hostname,
      port: requestUrl.port || undefined,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: init.method ?? "GET",
      servername: hostname,
      headers: Object.fromEntries(headers),
      lookup: createPinnedLookup(ips),
    }, (res) => {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") responseHeaders.set(key, value);
        else if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
      }
      if (status >= 300 && status < 400) {
        res.resume();
        req.destroy();
        reject(new SsrfError(`拒绝跟随 MCP 重定向（${status}）`));
        return;
      }
      if (status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      let received = 0;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      const stop = (error?: Error) => {
        res.destroy();
        req.destroy();
        if (closed) return;
        closed = true;
        try {
          if (error) controller?.error(error);
          else controller?.close();
        } catch { /* the body was already closed by the reader */ }
      };
      const body = new ReadableStream<Uint8Array>({
        start(control) { controller = control; },
        cancel() { stop(); },
      });
      const onAbort = () => stop();
      if (init.signal?.aborted) { stop(); return; }
      init.signal?.addEventListener("abort", onAbort, { once: true });
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MCP_RESPONSE_BYTE_LIMIT) {
          init.signal?.removeEventListener("abort", onAbort);
          stop(new SsrfError("MCP 响应超过体积上限"));
          return;
        }
        if (!closed) controller?.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => {
        init.signal?.removeEventListener("abort", onAbort);
        stop();
      });
      res.on("error", (error: Error) => stop(error));
      settled = true;
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const onAbort = () => { if (!settled) { req.destroy(); fail(new Error("Aborted")); } };
    if (init.signal?.aborted) { req.destroy(); fail(new Error("Aborted")); return; }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    req.on("error", fail);
    if (typeof init.body === "string") req.end(init.body);
    else req.end();
  });
}

/** Resolves and checks each origin once, then sends every request to those addresses. */
export function createPinnedMcpFetch(options: McpEgressOptions = {}) {
  const pins = new Map<string, { ips: string[] }>();
  return async (input: unknown, init?: { method?: string; headers?: Headers | Record<string, string>; body?: unknown; signal?: AbortSignal | null }): Promise<Response> => {
    const source = typeof input === "string" || input instanceof URL ? { url: String(input), method: init?.method, headers: init?.headers, signal: init?.signal } : input as { url: string; method?: string; headers?: Headers; signal?: AbortSignal; text?: () => Promise<string> };
    const signal = linkedSignal(options.deadline, init?.signal ?? source.signal);
    if (signal?.aborted) throw abortError(signal);
    const url = parseMcpUrl(source.url, options.allowLoopback === true);
    const origin = url.origin;
    let pin = pins.get(origin);
    if (!pin) {
      const resolved = await bounded(signal, pinMcpTarget(source.url, options));
      pin = { ips: resolved.ips };
      pins.set(origin, pin);
    }
    const target = new URL(source.url);
    const method = (init?.method ?? source.method ?? "GET").toUpperCase();
    const headerSource = init?.headers ?? source.headers;
    const headers = headerSource instanceof Headers ? headerSource : new Headers(headerSource as Record<string, string> | undefined);
    const readBody = source as { text?: () => Promise<string> };
    const body = method === "GET" || method === "HEAD"
      ? undefined
      : typeof init?.body === "string"
        ? init.body
        : typeof readBody.text === "function"
          ? await bounded(signal, readBody.text())
          : undefined;
    const connect = options.connect ?? connectPinnedMcp;
    const response = await connect(target, pin.ips, {
      method,
      headers,
      body,
      signal,
    });
    if (response.status >= 300 && response.status < 400) throw new SsrfError(`拒绝跟随 MCP 重定向（${response.status}）`);
    return response;
  };
}
