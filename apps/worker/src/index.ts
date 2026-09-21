import { CompletionOutbox } from "./completion-outbox.ts";
import { join } from "node:path";
import http from "node:http";
import { createContainerStopper } from "./stop-container.ts";
import { StringDecoder } from "node:string_decoder";
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
function docker(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path: "/v1.45" + path,
        headers: body ? { "Content-Type": "application/json" } : {},
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (b) => parts.push(b));
        response.on("end", () => {
          const text = Buffer.concat(parts).toString();
          if ((response.statusCode || 500) >= 400)
            return reject(
              Error(`Docker ${response.statusCode}: ${text.slice(0, 300)}`),
            );
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            resolve(text);
          }
        });
      },
    );
    request.setTimeout(15000, () => request.destroy(Error("Docker timeout")));
    request.on("error", reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function logs(
  id: string,
  onLine: (line: string) => void,
  timeoutMs: number,
) {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(
      {
        socketPath: "/var/run/docker.sock",
        path: `/v1.45/containers/${id}/logs?stdout=1&stderr=1&follow=1`,
      },
      (response) => {
        const decoder = new StringDecoder("utf8");
        let buffer = Buffer.alloc(0),
          text = "",
          total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 8 * 1024 * 1024) {
            request.destroy(Error("日志超出 8 MiB 限制"));
            return;
          }
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 8) {
            const length = buffer.readUInt32BE(4);
            if (length > 1024 * 1024) {
              request.destroy(Error("Invalid log frame"));
              return;
            }
            if (buffer.length < 8 + length) break;
            const channel = buffer[0];
            if (channel === 1)
              text += decoder.write(buffer.subarray(8, 8 + length));
            buffer = buffer.subarray(8 + length);
            let end;
            while ((end = text.indexOf("\n")) >= 0) {
              onLine(text.slice(0, end));
              text = text.slice(end + 1);
            }
          }
        });
        response.on("end", () => resolve());
        response.on("error", reject);
      },
    );
    const timeout = setTimeout(
      () => request.destroy(Error("Container log deadline exceeded")),
      timeoutMs,
    );
    request.on("close", () => clearTimeout(timeout));
    request.on("error", reject);
  });
}
const gatewayContainer =
  process.env.GATEWAY_CONTAINER || "pig-agent-cloud-gateway-1";
async function cleanupNetwork(id: string) {
  await docker("POST", `/networks/${id}/disconnect`, {
    Container: gatewayContainer,
    Force: true,
  }).catch(() => {});
  await docker("DELETE", `/networks/${id}`).catch(() => {});
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
  let network = "";
  let container = "",
    result: any = null,
    writes = Promise.resolve(),
    stopping = false,
    heartbeatBusy = false,
    completion: Record<string, unknown> | undefined,
    completionSaved = false,
    leaseLost = false;
  const started = Date.now();
  let eventSequence = 0;
  const stopper = createContainerStopper(docker, () => container);
  async function stop() {
    stopping = true;
    try {
      await stopper.stop();
    } catch {
      console.error(
        "Container stop unconfirmed; next pulse will retry",
        job.id,
      );
    }
  }
  activeStops.add(stop);
  const pulse = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void sendEvent(`/internal/runs/${job.id}/heartbeat`, { token: job.token })
      .then(async (r) => {
        if (
          stopper.requested ||
          r.state === "cancelling" ||
          r.state === "expired" ||
          Date.now() - started > resource.timeoutSeconds * 1000
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
    const isolated = await docker("POST", "/networks/create", {
      Name: "pig-" + job.id,
      Internal: true,
      Labels: {
        "pig-agent.managed": "true",
        "pig-agent.worker": workerId,
        "pig-agent.instance": instanceId,
        "pig-agent.cluster": namespace,
      },
    });
    network = isolated.Id;
    await docker("POST", `/networks/${network}/connect`, {
      Container: gatewayContainer,
      EndpointConfig: { Aliases: ["gateway"] },
    });
    const created = await docker(
      "POST",
      "/containers/create?name=pig-" + job.id,
      {
        Image: process.env.RUNNER_IMAGE || "pig-agent-runner:local",
        User: "1000:1000",
        Env: [
          `RUN_TOKEN=${job.token}`,
          `RUN_TIMEOUT_SECONDS=${Math.max(30, resource.timeoutSeconds - 15)}`,
          "GATEWAY_URL=http://gateway:8891",
          "PIG_DESKTOP=1",
          "PIG_APP_ROOT=/app",
          "DATA_DIR=/tmp/pig-data",
          "WORKSPACE_ROOT=/workspace",
        ],
        Labels: {
          "pig-agent.managed": "true",
          "pig-agent.worker": workerId,
          "pig-agent.instance": instanceId,
          "pig-agent.cluster": namespace,
          "pig-agent.run": job.id,
        },
        HostConfig: {
          NetworkMode: network,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Memory: resource.memoryMiB * 1024 * 1024,
          NanoCpus: Math.round(resource.cpu * 1000000000),
          PidsLimit: resource.pids,
          Tmpfs: {
            "/workspace": "rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
            "/tmp": "rw,nosuid,size=64m,uid=1000,gid=1000",
          },
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "8m", "max-file": "1" },
          },
        },
      },
    );
    container = created.Id;
    const lease = await sendEvent(`/internal/runs/${job.id}/heartbeat`, {
      token: job.token,
    });
    if (leaseLost || lease.state === "expired" || lease.state === "cancelling")
      throw Error("任务已取消或租约失效");
    await sendEvent(`/internal/runs/${job.id}/start`, { token: job.token });
    if (leaseLost || stopping) throw Error("Lease lost before container start");
    await docker("POST", `/containers/${container}/start`);
    await logs(
      container,
      (line) => {
        try {
          const item = JSON.parse(line);
          if (item.kind === "result") result = item;
          else if (item.kind === "event" && item.event?.type !== "token") {
            const eventId = `${job.id}:${++eventSequence}`;
            writes = writes
              .then(() =>
                sendEvent(`/internal/runs/${job.id}/event`, {
                  token: job.token,
                  event: item.event,
                  eventId,
                }),
              )
              .then(() => {})
              .catch((error) => {
                eventError = error;
              });
          }
        } catch {
          /* non-protocol stdout */
        }
      },
      (resource.timeoutSeconds + 30) * 1000,
    );
    await writes;
    if (eventError)
      console.error("Some execution events were not delivered", job.id);
    const inspected = await docker("GET", `/containers/${container}/json`);
    completion = {
      token: job.token,
      ...(result || {}),
      submissionId: randomUUID(),
      ok: !stopping && inspected.State.ExitCode === 0 && result?.ok === true,
      error: stopping
        ? "运行已取消或超时"
        : inspected.State.ExitCode === 0 && result?.ok === true
          ? undefined
          : result?.error || "容器未返回有效结果",
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
    activeStops.delete(stop);
    if (container && completionSaved)
      await docker("DELETE", `/containers/${container}?force=1&v=1`).catch(
        () => {},
      );
    if (network && completionSaved) await cleanupNetwork(network);
  }
}
// Snapshot IDs BEFORE registration. A delayed older process must never discover
// and delete containers belonging to a generation that registered after it.
async function orphanSnapshot() {
  const filter = encodeURIComponent(
    JSON.stringify({
      label: ["pig-agent.managed=true", "pig-agent.worker=" + workerId],
    }),
  );
  const containers = await docker(
    "GET",
    "/containers/json?all=1&filters=" + filter,
  );
  const networks = await docker("GET", "/networks?filters=" + filter);
  return {
    containers: containers.map((c: { Id: string }) => c.Id),
    networks: networks.map((n: { Id: string }) => n.Id),
  };
}
await outbox.recover();
const orphans = await orphanSnapshot();
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
for (const id of orphans.containers)
  await docker("DELETE", `/containers/${id}?force=1&v=1`).catch((error) => {
    if (!String(error).includes("Docker 404")) throw error;
  });
for (const id of orphans.networks) await cleanupNetwork(id);
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
