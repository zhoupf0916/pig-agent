import { pullLocalSchedules } from "./control-schedules.ts";
import { tickDueAutomations } from "./run.ts";

const DEFAULT_INTERVAL_MS = 30_000;

export type AutomationScheduler = {
  stop: () => void;
  tick: (now?: Date) => Promise<string[]>;
};

/**
 * In-process poller. No public webhooks / remote workers.
 * `createApp()` does not start this — `index.ts` does, so tests stay quiet.
 */
export function startAutomationScheduler(
  options: { intervalMs?: number; now?: () => Date } = {},
): AutomationScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const handle = setInterval(() => {
    void tickDueAutomations(now()).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[automations] scheduler tick failed: ${message}`);
    });
    void pullLocalSchedules().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[automations] control-plane schedule pull failed: ${message}`);
    });
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop: () => clearInterval(handle),
    tick: (at) => tickDueAutomations(at ?? now()),
  };
}
