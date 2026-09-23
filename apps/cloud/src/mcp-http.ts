import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exposedMcpToolName, isBlockedEgressAddress, isLoopbackAddress, isMetadataAddress, redactConfiguredSecret, redactSecretValue, type McpToolView } from "@pig-agent/contracts";

export class McpEgressError extends Error {}

export function endpointAllowlist(): Set<string> {
  return new Set((process.env.MCP_ENDPOINT_ALLOWLIST || "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function normalizeMcpEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new McpEgressError("MCP 地址无效"); }
  if (url.username || url.password) throw new McpEgressError("MCP 地址不能携带用户信息");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new McpEgressError("MCP 只允许 http 或 https");
  url.search = "";
  url.hash = "";
  return url;
}

export function permissionFor(url: URL, role: string): "public" | "allowlisted" {
  if (role === "admin" && endpointAllowlist().has(url.toString())) return "allowlisted";
  return "public";
}

export function assertResolvedAddresses(ips: string[], permission: "public" | "allowlisted"): void {
  for (const ip of ips) {
    if (isMetadataAddress(ip)) throw new McpEgressError("MCP 目标地址被拒绝");
    if (permission === "allowlisted") continue;
    if (isLoopbackAddress(ip) || isBlockedEgressAddress(ip)) throw new McpEgressError("MCP 目标地址被拒绝");
  }
}

export function assertCloudMcpUrl(raw: string, role: string): URL {
  const url = normalizeMcpEndpoint(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const permission = permissionFor(url, role);
  if (host === "localhost" || isIP(host)) assertResolvedAddresses([host === "localhost" ? "127.0.0.1" : host], permission);
  return url;
}

async function resolveHost(host: string, signal: AbortSignal): Promise<string[]> {
  if (isIP(host)) return [host];
  const records = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new McpEgressError("MCP 地址解析超时"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  ]);
  return records.map((record) => record.address);
}

function pinnedLookup(ips: string[]) {
  const records = ips.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));
  return (_hostname: string, options: unknown, callback?: (error: NodeJS.ErrnoException | null, address: string | typeof records, family?: number) => void) => {
    const cb = typeof options === "function" ? options as typeof callback : callback;
    if (!cb) return;
    const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: boolean }).all);
    if (all) cb(null, records);
    else cb(null, records[0]?.address ?? "", records[0]?.family ?? 4);
  };
}

function connectPinned(url: URL, ips: string[], init: { method?: string; headers?: Headers; body?: string; signal?: AbortSignal }): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol, hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET", servername: hostname, headers: Object.fromEntries(headers), lookup: pinnedLookup(ips),
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); req.destroy(); reject(new McpEgressError(`拒绝跟随 MCP 重定向（${status}）`)); return; }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") responseHeaders.set(key, value);
        else if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
      }
      if (status === 204 || status === 205 || status === 304) { res.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return; }
      let received = 0;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      const stop = (error?: Error) => {
        res.destroy(); req.destroy();
        if (closed) return;
        closed = true;
        try { if (error) controller?.error(error); else controller?.close(); } catch { /* already closed */ }
      };
      const body = new ReadableStream<Uint8Array>({ start(control) { controller = control; }, cancel() { stop(); } });
      const onAbort = () => stop();
      init.signal?.addEventListener("abort", onAbort, { once: true });
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 1_048_576) { stop(new McpEgressError("MCP 响应超过体积上限")); return; }
        if (!closed) controller?.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => stop());
      res.on("error", (error: Error) => stop(error));
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    const fail = (error: Error) => reject(error);
    const onAbort = () => { req.destroy(); fail(new McpEgressError("Aborted")); };
    if (init.signal?.aborted) { req.destroy(); fail(new McpEgressError("Aborted")); return; }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", fail);
    if (typeof init.body === "string") req.end(init.body);
    else req.end();
  });
}

export function createCloudMcpFetch(role: string, deadline: AbortSignal) {
  const pins = new Map<string, string[]>();
  return async (input: unknown, init?: { method?: string; headers?: Headers; body?: unknown; signal?: AbortSignal | null }): Promise<Response> => {
    const source = typeof input === "string" || input instanceof URL ? { url: String(input), method: init?.method, headers: init?.headers, signal: init?.signal } : input as { url: string; method?: string; headers?: Headers; signal?: AbortSignal; text?: () => Promise<string> };
    const signal = init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    if (signal.aborted) throw new McpEgressError("Aborted");
    const url = assertCloudMcpUrl(source.url, role);
    const permission = permissionFor(url, role);
    let ips = pins.get(url.origin);
    if (!ips) {
      ips = await resolveHost(url.hostname.replace(/^\[|\]$/g, ""), signal);
      assertResolvedAddresses(ips, permission);
      pins.set(url.origin, ips);
    }
    const method = (init?.method ?? source.method ?? "GET").toUpperCase();
    const headerSource = init?.headers ?? source.headers;
    const headers = headerSource instanceof Headers ? headerSource : new Headers(headerSource as Record<string, string> | undefined);
    const readBody = source as { text?: () => Promise<string> };
    const body = method === "GET" || method === "HEAD" ? undefined : typeof init?.body === "string" ? init.body : typeof readBody.text === "function" ? await readBody.text() : undefined;
    return connectPinned(url, ips, { method, headers, body, signal });
  };
}

type CloudServer = { id: string; name: string; url: string; timeoutMs: number; secret?: string; role: string };

async function withCloudClient<T>(config: CloudServer, run: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const timed = AbortSignal.any([AbortSignal.timeout(Math.min(120_000, Math.max(500, config.timeoutMs || 15_000))), ...(signal ? [signal] : [])]);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: createCloudMcpFetch(config.role, timed) as unknown as typeof globalThis.fetch,
    requestInit: { headers: config.secret ? { authorization: `Bearer ${config.secret}` } : {} },
  });
  const client = new Client({ name: "pig-agent", version: "0.3.0" }, { capabilities: {} });
  const stop = () => { void transport.close().catch(() => undefined); };
  timed.addEventListener("abort", stop, { once: true });
  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpEgressError(redactConfiguredSecret(message, config.secret) || "MCP 调用失败");
  } finally {
    timed.removeEventListener("abort", stop);
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function listRemoteTools(config: CloudServer, signal?: AbortSignal): Promise<McpToolView[]> {
  return withCloudClient(config, async (client) => {
    const listed = await client.listTools();
    return listed.tools.slice(0, 40).map((tool) => {
      const schema = redactSecretValue(tool.inputSchema, config.secret);
      const modelName = exposedMcpToolName(config.id, tool.name);
      const usable = schema && typeof schema === "object" && !Array.isArray(schema) && JSON.stringify(schema).length <= 8000;
      return {
        serverId: config.id,
        serverName: redactConfiguredSecret(config.name, config.secret),
        name: config.secret && tool.name.includes(config.secret) ? "" : tool.name,
        modelName: config.secret && tool.name.includes(config.secret) ? null : modelName,
        description: redactConfiguredSecret(tool.description ?? "", config.secret).slice(0, 400),
        inputSchema: usable ? schema as Record<string, unknown> : null,
        readOnlyHint: typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : null,
        skipReason: modelName && usable ? null : "工具名或参数不符合限制，未挂载",
      };
    });
  }, signal);
}

export async function callRemoteTool(config: CloudServer, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return withCloudClient(config, async (client) => {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal });
    return redactConfiguredSecret(JSON.stringify(result), config.secret).slice(0, 8000);
  }, signal);
}
