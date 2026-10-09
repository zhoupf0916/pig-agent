import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { parseTraceparent, Span, Tracer, type SpanSink } from "@pig-agent/contracts/telemetry";

/** Current span for code running inside a traced request or job. */
export const activeSpan = new AsyncLocalStorage<Span>();

/** The matched route pattern (bounded cardinality), e.g. `/v1/runs/:id`. */
export function routeOf(c: Context): string {
  try {
    const routes = matchedRoutes(c) as Array<{ method: string; path: string }>;
    const handler = [...routes].reverse().find((r) => r.method !== "ALL") ?? [...routes].reverse().find((r) => !/\*$/.test(r.path));
    return handler?.path ?? "unmatched";
  } catch {
    return "unmatched";
  }
}

export type RequestRecord = { method: string; route: string; status: number; seconds: number; span: Span; c: Context };

/**
 * Server span per request. Incoming `traceparent` is honoured; `shouldRecord` decides which spans are
 * stored (head sampling: run traces, explicitly traced calls, errors, slow requests), `onRequest` feeds metrics.
 */
export function tracingMiddleware(
  tracer: Tracer,
  opts: {
    shouldRecord: (r: RequestRecord) => boolean;
    onRequest?: (r: RequestRecord) => void;
    ignore?: (path: string) => boolean;
    /** Only trusted callers may join an existing trace (otherwise anyone could force spans to be stored). */
    trustParent?: (path: string) => boolean;
  },
): MiddlewareHandler {
  return async (c, next) => {
    if (opts.ignore?.(c.req.path)) return next();
    const parent = opts.trustParent && !opts.trustParent(c.req.path) ? undefined : parseTraceparent(c.req.header("traceparent"));
    const span = tracer.start(`${c.req.method} ${c.req.path}`, { parent, kind: "server" });
    const t0 = performance.now();
    let thrown: unknown;
    try {
      await activeSpan.run(span, next);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const route = routeOf(c);
      const status = thrown ? 500 : c.res.status;
      span.name = `${c.req.method} ${route}`;
      span.set({ "http.request.method": c.req.method, "http.route": route, "http.response.status_code": status });
      if (thrown) span.fail(thrown);
      const record: RequestRecord = { method: c.req.method, route, status, seconds: (performance.now() - t0) / 1000, span, c };
      try {
        opts.onRequest?.(record);
      } catch {
        /* metrics must not break requests */
      }
      span.end(status >= 500 ? "error" : "ok", opts.shouldRecord(record));
    }
  };
}

/**
 * fetch that propagates `traceparent` from the active span and records a client span per call.
 * Calls outside any span are passed through untouched.
 */
export function tracedFetch(
  tracer: Tracer,
  name: (url: URL, init?: RequestInit) => string,
  /** Defaults to the global fetch, resolved per call (so test spies and later patches apply). */
  base?: typeof fetch,
  /** Only our own services get the header; third parties (model providers) never see trace ids. */
  propagate: (url: URL) => boolean = () => true,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const parent = activeSpan.getStore();
    const send = base ?? globalThis.fetch;
    if (!parent) return send(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const span = tracer.start(name(url, init), {
      parent: parent.context,
      kind: "client",
      attributes: { "http.request.method": init?.method ?? "GET", "server.address": url.hostname, "url.path": url.pathname },
    });
    const headers = new Headers(init?.headers);
    if (propagate(url)) headers.set("traceparent", span.traceparent);
    try {
      const response = await send(input, { ...init, headers });
      span.set({ "http.response.status_code": response.status });
      span.end(response.status >= 500 ? "error" : response.status >= 400 ? "error" : "ok");
      return response;
    } catch (error) {
      span.fail(error).end("error");
      throw error;
    }
  }) as typeof fetch;
}

export { Tracer, type SpanSink };
