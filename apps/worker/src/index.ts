import http from "node:http";
import { hostname } from "node:os";
const control = process.env.CONTROL_URL || "http://cloud:8890",
  workerId = hostname();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string, body: unknown) {
  const r = await fetch(control + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw Error(`Control ${r.status}`);
  return r.json() as Promise<any>;
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
async function logs(id: string, onLine: (line: string) => void) {
  await new Promise<void>((resolve, reject) => {
    const request = http.get(
      {
        socketPath: "/var/run/docker.sock",
        path: `/v1.45/containers/${id}/logs?stdout=1&stderr=1&follow=1`,
      },
      (response) => {
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
              text += buffer.subarray(8, 8 + length).toString();
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
    request.on("error", reject);
  });
}
const gatewayContainer = "pig-agent-cloud-gateway-1";
async function cleanupNetwork(id: string) {
  await docker("POST", `/networks/${id}/disconnect`, {
    Container: gatewayContainer,
    Force: true,
  }).catch(() => {});
  await docker("DELETE", `/networks/${id}`).catch(() => {});
}
async function execute(job: { id: string; token: string }) {
  let eventError: unknown;
  let network = "";
  let container = "",
    result: any = null,
    writes = Promise.resolve(),
    stopping = false,
    heartbeatBusy = false,
    leaseLost = false;
  const started = Date.now();
  async function stop() {
    if (stopping || !container) return;
    stopping = true;
    await docker("POST", `/containers/${container}/stop?t=2`).catch(() => {});
  }
  const pulse = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void api(`/internal/runs/${job.id}/heartbeat`, { token: job.token })
      .then(async (r) => {
        if (
          r.state === "cancelling" ||
          r.state === "expired" ||
          Date.now() - started > 240000
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
      Labels: { "pig-agent.managed": "true", "pig-agent.worker": workerId },
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
          "GATEWAY_URL=http://gateway:8891",
          "PIG_DESKTOP=1",
          "PIG_APP_ROOT=/app",
          "DATA_DIR=/tmp/pig-data",
          "WORKSPACE_ROOT=/workspace",
        ],
        Labels: {
          "pig-agent.managed": "true",
          "pig-agent.worker": workerId,
          "pig-agent.run": job.id,
        },
        HostConfig: {
          NetworkMode: network,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1000000000,
          PidsLimit: 128,
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
    const lease = await api(`/internal/runs/${job.id}/heartbeat`, {
      token: job.token,
    });
    if (leaseLost || lease.state === "expired" || lease.state === "cancelling")
      throw Error("任务已取消或租约失效");
    await docker("POST", `/containers/${container}/start`);
    await api(`/internal/runs/${job.id}/start`, { token: job.token });
    await logs(container, (line) => {
      try {
        const item = JSON.parse(line);
        if (item.kind === "result") result = item;
        else if (item.kind === "event" && item.event?.type !== "token")
          writes = writes
            .then(() =>
              api(`/internal/runs/${job.id}/event`, {
                token: job.token,
                event: item.event,
              }),
            )
            .then(() => {})
            .catch((error) => {
              eventError = error;
            });
      } catch {
        /* non-protocol stdout */
      }
    });
    await writes;
    if (eventError) throw eventError;
    const inspected = await docker("GET", `/containers/${container}/json`);
    await api(`/internal/runs/${job.id}/finish`, {
      token: job.token,
      ...(result || {}),
      ok: !stopping && inspected.State.ExitCode === 0 && result?.ok === true,
      error: stopping
        ? "运行已取消或超时"
        : result?.error || "容器未返回有效结果",
    });
  } catch (error) {
    await stop();
    await api(`/internal/runs/${job.id}/finish`, {
      token: job.token,
      ok: false,
      error: error instanceof Error ? error.message : "Worker failure",
    }).catch(() => {});
  } finally {
    clearInterval(pulse);
    if (container)
      await docker("DELETE", `/containers/${container}?force=1&v=1`).catch(
        () => {},
      );
    if (network) await cleanupNetwork(network);
  }
}
// Reconcile containers left by a terminated worker before accepting more work.
async function reap() {
  const all = await docker(
    "GET",
    "/containers/json?all=1&filters=" +
      encodeURIComponent(JSON.stringify({ label: ["pig-agent.managed=true"] })),
  );
  for (const c of all) {
    if (c.Labels?.["pig-agent.worker"] === workerId)
      await docker("DELETE", `/containers/${c.Id}?force=1&v=1`);
  }
  const networks = await docker(
    "GET",
    "/networks?filters=" +
      encodeURIComponent(JSON.stringify({ label: ["pig-agent.managed=true"] })),
  );
  for (const n of networks)
    if (n.Labels?.["pig-agent.worker"] === workerId) await cleanupNetwork(n.Id);
}
await reap();
console.log("Worker ready", workerId);
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (true) {
      try {
        const job = await api("/internal/claim", { workerId });
        if (job) await execute(job);
        else await delay(1000);
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : "Worker unavailable",
        );
        await delay(3000);
      }
    }
  }),
);
