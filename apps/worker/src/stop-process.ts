import type { ChildProcess } from "node:child_process";
/** TERM then KILL the detached trusted Agent group. bwrap --die-with-parent kills its namespace. */
export function createProcessStopper(
  child: () =>
    | Pick<ChildProcess, "pid" | "exitCode" | "signalCode">
    | undefined,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let requested = false;
  let pending: Promise<void> | undefined;
  const live = () => {
    const value = child();
    return value?.pid && value.exitCode === null && value.signalCode === null
      ? value.pid
      : undefined;
  };
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  return {
    get requested() {
      return requested;
    },
    stop() {
      requested = true;
      if (pending) return pending;
      const pid = live();
      if (!pid) return Promise.resolve();
      pending = (async () => {
        send(pid, "SIGTERM");
        await wait(1500);
        // Do not target a process group after its leader exited or was replaced.
        if (live() === pid) send(pid, "SIGKILL");
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
