import { isBlockedEgressAddress } from "@pig-agent/contracts";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const MAX_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_MAX_BYTES = 400_000;
export const MAX_FETCH_MAX_BYTES = 800_000;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "127.0.0.1",
  "::",
  "::1",
  "[::1]",
  "metadata.google.internal",
  "metadata",
]);

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export type LookupFn = (hostname: string) => Promise<string[]>;

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const ranges: Array<[number, number]> = [
    [0x00000000, 0xff000000], // 0.0.0.0/8
    [0x0a000000, 0xff000000], // 10.0.0.0/8
    [0x7f000000, 0xff000000], // 127.0.0.0/8
    [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
    [0xac100000, 0xfff00000], // 172.16.0.0/12
    [0xc0a80000, 0xffff0000], // 192.168.0.0/16
    [0x64400000, 0xffc00000], // 100.64.0.0/10
    [0xc0000000, 0xffffff00], // 192.0.0.0/24
    [0xe0000000, 0xf0000000], // 224.0.0.0/4 multicast
    [0xf0000000, 0xf0000000], // 240.0.0.0/4 reserved, including broadcast
  ];
  return ranges.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

export function isPrivateIPv6(ip: string): boolean {
  return isBlockedEgressAddress(ip);
}

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.replace(/^\[|\]$/g, "");
  const version = isIP(trimmed);
  if (version === 4) return isPrivateIPv4(trimmed);
  if (version === 6) return isPrivateIPv6(trimmed);
  return true;
}

export function hostAllowed(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new SsrfError("URLs with credentials are not allowed");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("URL host is required");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new SsrfError("Host is blocked");
  }
  if (host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home")) {
    throw new SsrfError("Host is blocked");
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new SsrfError("Private or loopback IP is blocked");
  }
  return url;
}

export async function resolvePublicIps(
  hostname: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<string[]> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfError("Private or loopback IP is blocked");
    }
    return [hostname];
  }
  let ips: string[];
  try {
    ips = await lookupFn(hostname);
  } catch {
    throw new SsrfError(`Cannot resolve host: ${hostname}`);
  }
  if (ips.length === 0) {
    throw new SsrfError(`Cannot resolve host: ${hostname}`);
  }
  const blocked = ips.filter((ip) => isPrivateIp(ip));
  if (blocked.length > 0) {
    throw new SsrfError("Host resolves to a private or loopback address");
  }
  return ips;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

export type PinnedConnect = (url: URL, ips: string[], signal: AbortSignal) => Promise<Response>;

export function createPinnedLookup(ips: readonly string[]) {
  const records = ips.map((address) => ({
    address,
    family: (address.includes(":") ? 6 : 4) as 4 | 6,
  }));
  return (
    _hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, address: string | typeof records, family?: number) => void,
  ) => {
    const cb = typeof options === "function" ? options as typeof callback : callback;
    if (!cb) return;
    const all = typeof options === "object" && options !== null && "all" in options && Boolean((options as { all?: boolean }).all);
    if (all) cb(null, records);
    else cb(null, records[0]?.address ?? "", records[0]?.family ?? 4);
  };
}

function fetchWithPinnedIps(url: URL, ips: string[], signal: AbortSignal): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: hostname,
        headers: {
          host: url.host,
          accept: "text/*,application/json,application/xml;q=0.9,*/*;q=0.1",
        },
        lookup: createPinnedLookup(ips),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export type SafeFetchDeps = {
  lookup?: LookupFn;
  connect?: PinnedConnect;
};

export async function safeHttpFetch(
  rawUrl: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    allowlist?: string[];
    signal?: AbortSignal;
  } = {},
  deps: SafeFetchDeps = {},
): Promise<{
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}> {
  const url = parseHttpUrl(rawUrl);
  const allowlist = options.allowlist ?? [];
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new SsrfError(`Host is not on the HTTP fetch allowlist: ${url.hostname}`);
  }
  const ips = await resolvePublicIps(url.hostname.replace(/^\[|\]$/g, ""), deps.lookup ?? defaultLookup);

  const timeout = clamp(
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    1_000,
    MAX_FETCH_TIMEOUT_MS,
  );
  const maxBytes = clamp(
    options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES,
    1_024,
    MAX_FETCH_MAX_BYTES,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const connect = deps.connect ?? fetchWithPinnedIps;
  let response: Response;
  try {
    response = await connect(url, ips, controller.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      throw new SsrfError(`HTTP fetch timed out or was cancelled (${timeout}ms)`);
    }
    throw new SsrfError(`HTTP fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SsrfError(`Refusing to follow HTTP redirect (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = new Uint8Array(await response.arrayBuffer());
  const truncated = raw.byteLength > maxBytes;
  const slice = truncated ? raw.slice(0, maxBytes) : raw;
  if (slice.includes(0)) {
    throw new SsrfError("Refusing to return a binary HTTP body");
  }
  return {
    url: url.toString(),
    status: response.status,
    contentType,
    body: new TextDecoder("utf-8", { fatal: false }).decode(slice),
    truncated,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
