import { createProcessStopper } from "./stop-process.ts";
import { processUsage } from "./process-budget.ts";
import { EventBatcher } from "./event-batcher.ts";
import { CompletionOutbox } from "./completion-outbox.ts";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
const control = process.env.CONTROL_URL || "http://cloud:8890",
  workerId = process.env.WORKER_ID || hostname();
const instanceId = randomUUID();
const namespace = process.env.WORKER_NAMESPACE || "pig-agent-cloud";
const slots = Number(process.env.WORKER_CAPACITY || 3);
if (!Number.isInteger(slots) || slots < 1 || slots > 16)
  throw Error("WORKER_CAPACITY must be 1..16");
const profiles = (
  process.env.WORKER_PROFILES || "compact,standard,large"
).split(",");
let draining = false;
const activeStops = new Set<() => Promise<void>>();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string, body: unknown) {
  const r = await fetch(control + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw Error(`Control ${r.status}`);
  return r.json() as Promise<any>;
}
const outbox = new CompletionOutbox(
  process.env.WORKER_OUTBOX_DIR ||
    join(process.cwd(), "data", "worker-outbox", namespace, workerId),
  api,
);
async function sendEvent(path: string, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(path, body);
    } catch (error) {
      if (attempt >= 2 || /Control 4\d\d/.test(String(error))) throw error;
      await delay(200 * (attempt + 1));
    }
  }
}
async function execute(job: {
  id: string;
  token: string;
  resources?: {
    memoryMiB: number;
    cpu: number;
    pids: number;
    timeoutSeconds: number;
  };
}) {
  const resource = job.resources || {
    memoryMiB: 512,
    cpu: 1,
    pids: 128,
    timeoutSeconds: 240,
  };
  let eventError: unknown;
  let workspace = "";
  let child: ReturnType<typeof spawn> | undefined;
  let result: any = null,
    writes = Promise.resolve(),
    stopping = false,
    heartbeatBusy = false,
    completion: Record<string, unknown> | undefined,
    completionSaved = false,
    leaseLost = false;
  let budgetError: string | undefined;
  let budgetBusy = false;
  const budgetPulse = setInterval(() => {
    if (!child?.pid || budgetBusy) return;
    budgetBusy = true;
    void processUsage(child.pid)
      .then(async (usage) => {
        if (
          usage.memoryBytes > resource.memoryMiB * 1024 * 1024 ||
          usage.pids > resource.pids ||
          usage.cpuSeconds > resource.cpu * resource.timeoutSeconds
        ) {
          budgetError = "任务超过原生进程内存、进程数或 CPU 总时间限额";
          await stop();
        }
      })
      .catch(async () => {
        budgetError = "无法核验原生进程资源限额";
        await stop();
      })
      .finally(() => {
        budgetBusy = false;
      });
  }, 500);
  let eventSequence = 0;
  const eventBatcher = new EventBatcher((event) => {
    const eventId = `${job.id}:${++eventSequence}`;
    writes = writes
      .then(() =>
        sendEvent(`/internal/runs/${job.id}/event`, {
          token: job.token,
          event,
          eventId,
        }),
      )
      .then(() => {})
      .catch((error) => {
        eventError = error;
      });
  });
  const stopper = createProcessStopper(() => child);
  async function stop() {
    stopping = true;
    try { await stopper.stop(); } catch { console.error("Native process stop unconfirmed; retrying on next pulse", job.id); }
  }
  activeStops.add(stop);
  const pulse = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void sendEvent(`/internal/runs/${job.id}/heartbeat`, { token: job.token })
      .then(async (r) => {
        if (
          stopping ||
          r.state === "cancelling" ||
          r.state === "expired" ||
          (r.deadlineAt ? Date.parse(r.deadlineAt) <= Date.now() : false)
        ) {
          leaseLost = r.state === "expired";
          await stop();
        }
      })
      .catch(async () => {
        leaseLost = true;
        await stop();
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 2000);
  try {
    workspace = await mkdtemp("/tmp/pig-job-");
    await mkdir(join(workspace, "workspace"));
    const lease = await sendEvent(`/internal/runs/${job.id}/heartbeat`, {
      token: job.token,
    });
    if (leaseLost || lease.state === "expired" || lease.state === "cancelling")
      throw Error("任务已取消或租约失效");
    await sendEvent(`/internal/runs/${job.id}/start`, { token: job.token });
    if (leaseLost || stopping)
      throw Error("Lease lost before native runner start");
    child = spawn(process.execPath, ["/app/runner.mjs"], {
      detached: true,
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: workspace,
        RUN_TOKEN: job.token,
        RUN_TIMEOUT_SECONDS: String(Math.max(30, resource.timeoutSeconds - 15)),
        GATEWAY_URL: process.env.GATEWAY_URL || "http://gateway:8891",
        PIG_DESKTOP: "1",
        PIG_APP_ROOT: "/app",
        DATA_DIR: join(workspace, "data"),
        WORKSPACE_ROOT: join(workspace, "workspace"),
        PIG_AGENT_FORCE_NATIVE_SANDBOX: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let total = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 8 * 1024 * 1024) void stop();
    });
    child.stderr!.on("data", () => {});
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        const item = JSON.parse(line);
        if (item.kind === "result") result = item;
        else if (item.kind === "event" && item.event?.type)
          eventBatcher.push(item.event);
      } catch {
        /* non-protocol stdout */
      }
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child!.on("error", reject);
      child!.on("close", resolve);
    });
    lines.close();
    eventBatcher.flush();
    await writes;
    if (eventError)
      console.error("Some execution events were not delivered", job.id);
    completion = {
      token: job.token,
      ...(result || {}),
      submissionId: randomUUID(),
      ok: !stopping && exitCode === 0 && result?.ok === true,
      error: stopping
        ? budgetError || "运行已取消或超时"
        : exitCode === 0 && result?.ok === true
          ? undefined
          : result?.error || "原生 Runner 未返回有效结果",
    };
  } catch (error) {
    await stop();
    completion = {
      token: job.token,
      submissionId: randomUUID(),
      ok: false,
      error: error instanceof Error ? error.message : "Worker failure",
    };
  } finally {
    eventBatcher.flush();
    await writes;
    // Never turn delivery failure into execution failure or discard the original result.
    if (completion) {
      try {
        const item = { runId: job.id, body: completion };
        await outbox.save(item);
        completionSaved = true;
        if (!(await outbox.deliver(item)))
          console.error("Completion retained in outbox", job.id);
      } catch {
        console.error("Completion persistence/delivery unavailable", job.id);
      }
    }
    clearInterval(pulse);
    clearInterval(budgetPulse);
    activeStops.delete(stop);
    if (workspace && completionSaved)
      await rm(workspace, { recursive: true, force: true });
  }
}
// Fail closed before registration/claim: never fall back to unsandboxed execution.
execFileSync(
  "bwrap",
  [
    "--unshare-all",
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "/bin/true",
  ],
  { timeout: 5000 },
);
await outbox.recover();
// Container-private /tmp: a restart cannot retain a live child; remove prior job data.
for (const entry of await readdir("/tmp"))
  if (entry.startsWith("pig-job-"))
    await rm(join("/tmp", entry), { recursive: true, force: true });
for (let attempt = 0; ; attempt++) {
  try {
    await api("/internal/workers/register", {
      workerId,
      instanceId,
      capacity: slots,
      profiles,
    });
    break;
  } catch (error) {
    if (attempt >= 11 || /Control 4\d\d/.test(String(error))) throw error;
    console.error(
      "Registration temporarily unavailable; retrying same generation",
      workerId,
    );
    await delay(Math.min(2000, 500 * (attempt + 1)));
  }
}
console.log("Worker ready", workerId, "slots", slots);
let recoveryBusy = false;
const recoveryPulse = setInterval(() => {
  if (recoveryBusy) return;
  recoveryBusy = true;
  void outbox
    .recover()
    .catch(() => console.error("Completion recovery unavailable"))
    .finally(() => {
      recoveryBusy = false;
    });
}, 30000);
let nodePulseBusy = false;
const nodePulse = setInterval(() => {
  if (nodePulseBusy) return;
  nodePulseBusy = true;
  void api("/internal/workers/heartbeat", { workerId, instanceId, draining })
    .catch((error) => {
      // A stale process must never re-register itself and displace its replacement.
      if (String(error).includes("409")) {
        draining = true;
        void Promise.allSettled([...activeStops].map((stop) => stop()));
      }
      console.error("Node heartbeat unavailable");
    })
    .finally(() => {
      nodePulseBusy = false;
    });
}, 3000);
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
function shutdown() {
  if (draining) return;
  draining = true;
  console.log("Worker draining", workerId);
  void api("/internal/workers/heartbeat", {
    workerId,
    instanceId,
    draining: true,
  }).catch(() => {});
  shutdownTimer = setTimeout(
    () => {
      void Promise.allSettled([...activeStops].map((stop) => stop()));
    },
    Number(process.env.WORKER_SHUTDOWN_SECONDS || 25) * 1000,
  );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await Promise.all(
  Array.from({ length: slots }, async () => {
    while (!draining) {
      try {
        const job = await api("/internal/claim", { workerId, instanceId });
        if (job) await execute(job);
        else await delay(1000);
      } catch (error) {
        if (String(error).includes("409")) {
          draining = true;
          break;
        }
        console.error(
          error instanceof Error ? error.message : "Worker unavailable",
        );
        await delay(3000);
      }
    }
  }),
);
clearInterval(nodePulse);
clearInterval(recoveryPulse);
if (shutdownTimer) clearTimeout(shutdownTimer);
console.log("Worker drained", workerId);
