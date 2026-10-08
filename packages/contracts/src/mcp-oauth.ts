/**
 * OAuth 2.1 for remote MCP servers (machine-to-machine), shared by the desktop/local server
 * and the cloud control plane. Runtime-neutral (no node: imports); callers pass their own
 * SSRF-pinned fetch so token/discovery requests obey the same egress policy as MCP traffic.
 *
 * The stored MCP credential stays a single secret string. If it is a JSON descriptor
 *   {"type":"oauth_client_credentials","clientId":"…","clientSecret":"…","scope":"…","tokenUrl":"…"}
 * we run the client_credentials grant and send the access token as Bearer. When tokenUrl is
 * omitted it is discovered per the MCP authorization spec: RFC 9728 protected-resource metadata
 * → RFC 8414 authorization-server metadata → token_endpoint. Tokens are cached per
 * (server URL, credential) until shortly before expiry and invalidated on HTTP 401.
 * Anything else is treated as a static bearer token.
 */
export type OAuthClientCredentials = { type: "oauth_client_credentials"; clientId: string; clientSecret: string; scope?: string; tokenUrl?: string; resource?: string };
export type OAuthFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export function parseOAuthSecret(secret: string | undefined): OAuthClientCredentials | null {
  if (!secret || !secret.trimStart().startsWith("{")) return null;
  try {
    const v = JSON.parse(secret) as Partial<OAuthClientCredentials>;
    if (v.type !== "oauth_client_credentials" || typeof v.clientId !== "string" || typeof v.clientSecret !== "string" || !v.clientId || !v.clientSecret) return null;
    return { type: v.type, clientId: v.clientId, clientSecret: v.clientSecret, scope: typeof v.scope === "string" ? v.scope : undefined, tokenUrl: typeof v.tokenUrl === "string" ? v.tokenUrl : undefined, resource: typeof v.resource === "string" ? v.resource : undefined };
  } catch { return null; }
}

type Entry = { token: string; expiresAt: number; secret: string };
const cache = new Map<string, Entry>();
const keyOf = (serverUrl: string, secret: string) => `${serverUrl}\n${secret}`;

/** Values that must never appear in errors / tool output for this credential. */
export function credentialSecrets(secret: string | undefined): string[] {
  if (!secret) return [];
  const tokens = [...cache.values()].filter((e) => e.secret === secret).map((e) => e.token);
  return [secret, parseOAuthSecret(secret)?.clientSecret, ...tokens].filter((s): s is string => Boolean(s));
}

export function redactCredential(text: string, secret: string | undefined, mask = "[redacted]"): string {
  return credentialSecrets(secret).sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join(mask), text);
}

export function invalidateToken(serverUrl: string, secret: string | undefined): void { if (secret) cache.delete(keyOf(serverUrl, secret)); }
export function resetOAuthCacheForTests(): void { cache.clear(); }

/** HTTP 401 from the MCP SDK (StreamableHTTPError.code) or a message mentioning it. */
export function isUnauthorizedError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 401 || /\b401\b|unauthori[sz]ed/i.test(String((error as Error)?.message ?? error));
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what}失败（HTTP ${res.status}）`);
  return await res.json() as Record<string, unknown>;
}

export async function discoverTokenEndpoint(serverUrl: string, fetchImpl: OAuthFetch): Promise<string> {
  const origin = new URL(serverUrl).origin;
  const prm = await json(await fetchImpl(`${origin}/.well-known/oauth-protected-resource`), "读取 MCP 授权元数据");
  const as = Array.isArray(prm.authorization_servers) ? String(prm.authorization_servers[0] ?? "") : "";
  if (!as) throw new Error("MCP 服务未声明授权服务器");
  const asUrl = new URL(as);
  const meta = await json(await fetchImpl(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname === "/" ? "" : asUrl.pathname}`), "读取授权服务器元数据");
  if (typeof meta.token_endpoint !== "string") throw new Error("授权服务器缺少 token_endpoint");
  return meta.token_endpoint;
}

function basic(id: string, secret: string): string {
  const raw = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;
  return btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
}

/** Bearer value to send, or undefined for unauthenticated servers. */
export async function resolveBearer(serverUrl: string, secret: string | undefined, fetchImpl: OAuthFetch, now = Date.now()): Promise<string | undefined> {
  if (!secret) return undefined;
  const o = parseOAuthSecret(secret);
  if (!o) return secret;
  const key = keyOf(serverUrl, secret);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.token;
  const tokenUrl = o.tokenUrl ?? await discoverTokenEndpoint(serverUrl, fetchImpl);
  const body = new URLSearchParams({ grant_type: "client_credentials", ...(o.scope ? { scope: o.scope } : {}), resource: o.resource ?? serverUrl });
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic(o.clientId, o.clientSecret)}` },
    body: body.toString(),
  });
  const data = await json(res, "获取 MCP 访问令牌");
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("授权服务器未返回 access_token");
  const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  cache.set(key, { token: data.access_token, expiresAt: now + Math.max(5, ttl - 60) * 1000, secret });
  return data.access_token;
}
