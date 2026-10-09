// Browser glue for the installable workbench: worker registration, update hand-off, install prompt and
// background notifications. Everything degrades to a no-op where the APIs are missing (desktop shell, http).
import { useSyncExternalStore } from "react";
import { NOTIFY_KEY, isIosSafari, notificationState, openTarget, type PwaSnapshot } from "./pwa-state";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

let registered = false;
let waiting: ServiceWorker | null = null;
let installPrompt: InstallPrompt | null = null;
let snapshot: PwaSnapshot = read();
const listeners = new Set<() => void>();

function standalone() {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true)
  );
}

function read(): PwaSnapshot {
  const supported = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
  let preference: string | null = null;
  try {
    preference = localStorage.getItem(NOTIFY_KEY);
  } catch {}
  const installed = standalone();
  return {
    updateReady: !!waiting,
    canInstall: !!installPrompt && !installed,
    installed,
    iosHint: typeof navigator !== "undefined" && !installed && isIosSafari(navigator.userAgent, navigator.maxTouchPoints || 0),
    notifications: notificationState({ supported, permission: supported ? Notification.permission : "default", preference }),
  };
}

function publish() {
  snapshot = read();
  for (const listener of listeners) listener();
}

export function usePwa() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

function trackWaiting(registration: ServiceWorkerRegistration) {
  const offer = (worker: ServiceWorker | null) => {
    // Only an update (a controller already exists) needs a reload; the very first install is silent.
    if (worker && navigator.serviceWorker.controller) {
      waiting = worker;
      publish();
    }
  };
  offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const next = registration.installing;
    next?.addEventListener("statechange", () => {
      if (next.state === "installed") offer(next);
    });
  });
}

/** Registers /sw.js for the cloud workbench. Skipped in dev, inside the desktop app and on insecure origins. */
export function registerWorkbenchWorker() {
  if (registered || !import.meta.env.PROD || !("serviceWorker" in navigator) || !window.isSecureContext || window.pigDesktop) return;
  registered = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    publish();
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "PIG_OPEN") return;
    const hash = openTarget(event.data.url);
    if (hash) location.hash = hash;
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!waiting || reloading) return;
    reloading = true;
    location.reload();
  });
  const start = () =>
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        trackWaiting(registration);
        // Long-lived tabs (an installed app) check for a new deploy hourly and when they come back.
        setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) void registration.update().catch(() => {});
        });
      })
      .catch(() => {});
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

export function applyUpdate() {
  if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
  else location.reload();
}

export async function promptInstall() {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => ({ outcome: "dismissed" }));
  publish();
  return choice.outcome === "accepted";
}

/** Must run from a click: browsers only show the permission prompt for a user gesture. */
export async function setNotifications(enabled: boolean) {
  if (!("Notification" in window)) return;
  try {
    if (!enabled) localStorage.setItem(NOTIFY_KEY, "off");
    else if ((await Notification.requestPermission()) === "granted") localStorage.setItem(NOTIFY_KEY, "on");
  } catch {}
  publish();
}

export function notificationsEnabled() {
  return read().notifications === "on";
}

/** Shows a notification only while the workbench is in the background; clicking it reopens `hash`. */
export async function notifyInBackground(notice: { title: string; body: string }, hash: string, tag: string) {
  if (!document.hidden || !notificationsEnabled()) return;
  const options: NotificationOptions = { body: notice.body, tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: "/" + hash } };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await registration.showNotification(notice.title, options);
    else new Notification(notice.title, options);
  } catch {}
}
