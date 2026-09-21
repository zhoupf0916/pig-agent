import { loadSettings } from "../store/settings.ts";
import { resolveEffectiveCloudBaseUrl } from "../agent/cloud/env-json.ts";

/** Credentials stay in the local service / desktop vault, never sent to the renderer. */
export async function planeFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return createPlaneClient(await loadSettings()).fetch(path, init);
}

/** Pin one connection for multi-request operations such as importing a run snapshot. */
export function createPlaneClient(
  settings: Awaited<ReturnType<typeof loadSettings>>,
) {
  const base = resolveEffectiveCloudBaseUrl(settings).replace(/\/+$/, "");
  if (!base || !settings.cloudToken.trim())
    throw Error("请先在设置中配置远端控制面地址和访问令牌");
  const token = settings.cloudToken.trim();
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
        Authorization: `Bearer ${token}`,
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
  };
  return {
    fetch: request,
    json: async <T = Record<string, unknown>>(
      path: string,
      init: RequestInit = {},
    ) => {
      const response = await request(path, init);
      const data = (await response.json()) as { error?: string };
      if (!response.ok)
        throw Error(data.error || `Control HTTP ${response.status}`);
      return data as T;
    },
  };
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
