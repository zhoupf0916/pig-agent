// Workbench service worker. Built by the `pigServiceWorker` Vite plugin into /sw.js with the build version
// and the entry assets baked in. Only the static shell is cached (see sw-policy.ts).
import { cacheName, cacheable, staleCaches, strategyFor } from "./sw-policy";

declare const __PIG_VERSION__: string;
declare const __PIG_PRECACHE__: string[];

const scope = self as unknown as ServiceWorkerGlobalScope;
const CACHE = cacheName(__PIG_VERSION__);

scope.addEventListener("install", (event) => {
  // Precache the shell and its entry assets; a failure aborts install and the old worker stays in charge.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", ...__PIG_PRECACHE__])));
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(staleCaches(keys, __PIG_VERSION__).map((key) => caches.delete(key))))
      .then(() => scope.clients.claim()),
  );
});

scope.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void scope.skipWaiting();
});

async function store(request: Request, response: Response) {
  if (!cacheable(response)) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
}

async function shell(request: Request) {
  // Network first so a deploy is picked up immediately; the cached shell only serves when offline.
  try {
    const response = await fetch(request);
    if (cacheable(response)) await store(new Request("/"), response.clone());
    return response;
  } catch {
    const cached = (await caches.match("/", { cacheName: CACHE })) || (await caches.match("/"));
    if (cached) return cached;
    return new Response("<!doctype html><meta charset=utf-8><title>Pig Agent</title><p>当前离线，请联网后重试。</p>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function asset(request: Request) {
  // Hashed file names never change content, so cache first is safe.
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await store(request, response);
  return response;
}

async function staticFile(request: Request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      await store(request, response);
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || network;
}

scope.addEventListener("fetch", (event) => {
  const request = event.request;
  const strategy = strategyFor({ method: request.method, mode: request.mode, url: request.url }, scope.location.origin);
  if (strategy === "bypass") return;
  event.respondWith(strategy === "shell" ? shell(request) : strategy === "asset" ? asset(request) : staticFile(request));
});

scope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  const url = new URL(target, scope.location.origin);
  if (url.origin !== scope.location.origin) return;
  event.waitUntil(
    scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => new URL(client.url).origin === url.origin);
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "PIG_OPEN", url: url.pathname + url.search + url.hash });
        return;
      }
      await scope.clients.openWindow(url.href);
    }),
  );
});
