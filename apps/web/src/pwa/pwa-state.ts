// Installable-app state shared by the update toast and the settings card. Pure where possible (tested).

export interface PwaSnapshot {
  /** A new worker finished installing and waits for the user to reload. */
  updateReady: boolean;
  /** Chromium's deferred install prompt is available. */
  canInstall: boolean;
  /** Running as an installed app (standalone display mode). */
  installed: boolean;
  /** iOS Safari: no prompt API, the user adds it via Share → Add to Home Screen. */
  iosHint: boolean;
  notifications: NotificationState;
}

export type NotificationState = "unsupported" | "off" | "on" | "blocked";

export const NOTIFY_KEY = "pig-agent.notify";

export function notificationState(input: { supported: boolean; permission: string; preference: string | null }): NotificationState {
  if (!input.supported) return "unsupported";
  if (input.permission === "denied") return "blocked";
  return input.permission === "granted" && input.preference === "on" ? "on" : "off";
}

export function isIosSafari(userAgent: string, maxTouchPoints: number) {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

/** Workbench routes are hash routes; accept only same-origin hash/path targets from a notification click. */
export function openTarget(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const hash = raw.indexOf("#");
  return hash >= 0 ? raw.slice(hash) : null;
}

export type RunOutcome = "succeeded" | "failed" | "cancelled";

/** What to tell the user when a run they were watching changes while the app is in the background. */
export function runNotice(kind: "finished" | "approval", title: string, outcome?: RunOutcome) {
  const name = title.trim().slice(0, 60) || "新任务";
  if (kind === "approval") return { title: "需要你的审批", body: `「${name}」正在等待操作确认` };
  if (outcome === "failed") return { title: "任务失败", body: `「${name}」执行失败，点击查看原因` };
  if (outcome === "cancelled") return { title: "任务已取消", body: `「${name}」已取消` };
  return { title: "任务已完成", body: `「${name}」已完成，点击查看结果` };
}
