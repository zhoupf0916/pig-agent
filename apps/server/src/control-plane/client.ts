import { loadSettings } from "../store/settings.ts";
import { resolveEffectiveCloudBaseUrl } from "../agent/cloud/env-json.ts";

/** Credentials stay in the local service / desktop vault, never sent to the renderer. */
export async function planeFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const settings = await loadSettings();
  const base = resolveEffectiveCloudBaseUrl(settings).replace(/\/+$/, "");
  if (!base || !settings.cloudToken.trim())
    throw Error("请先在设置中配置远端控制面地址和访问令牌");
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: `Bearer ${settings.cloudToken.trim()}`,
    },
  });
  // Fetch headers are immutable; Hono CORS must be able to append response headers.
  const headers = new Headers(response.headers);
  for (const name of ["content-encoding", "content-length", "set-cookie"])
    headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
export async function planeJson<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
) {
  const response = await planeFetch(path, init);
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw Error(data.error || `控制面 HTTP ${response.status}`);
  return data as T;
}
