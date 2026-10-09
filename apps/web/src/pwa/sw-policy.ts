// Pure caching policy for the workbench service worker. Kept free of DOM/SW globals so it is unit-tested.
// Rule of thumb: only the static app shell is ever cached. API, auth, admin and streaming traffic always
// goes straight to the network, so no account data can end up in Cache Storage.

export type Strategy = "shell" | "asset" | "static" | "bypass";

export interface RequestInfo {
  method: string;
  mode: string;
  url: string;
}

const NEVER_CACHE = [
  "/v1/",
  "/auth/",
  "/internal/",
  "/admin",
  "/api/",
  "/api-docs",
  "/debug",
  "/openapi.json",
  "/metrics",
  "/health",
  "/.well-known/",
  "/sw.js",
];

/** Navigations that render the workbench shell (index.html). */
const SHELL_PATHS = new Set(["/", "/index.html"]);

export function strategyFor(request: RequestInfo, origin: string): Strategy {
  if (request.method !== "GET") return "bypass";
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== origin) return "bypass";
  const path = url.pathname;
  if (NEVER_CACHE.some((prefix) => path === prefix || path.startsWith(prefix))) return "bypass";
  if (request.mode === "navigate") return SHELL_PATHS.has(path) ? "shell" : "bypass";
  if (path.startsWith("/assets/")) return "asset";
  if (path.startsWith("/icons/") || path === "/manifest.webmanifest") return "static";
  return "bypass";
}

export const CACHE_PREFIX = "pig-shell-";

export function cacheName(version: string) {
  return CACHE_PREFIX + version;
}

/** Caches from earlier builds that `activate` should delete. Foreign caches are left alone. */
export function staleCaches(keys: readonly string[], version: string) {
  return keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== cacheName(version));
}

/** Only complete, same-origin, successful responses are stored. */
export function cacheable(response: { ok: boolean; status: number; type: string; headers: { get(name: string): string | null } }) {
  if (!response.ok || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  const control = response.headers.get("Cache-Control") || "";
  return !/no-store|private/i.test(control);
}
