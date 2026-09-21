import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "pig-plane-ui-"));
process.env.PIG_DESKTOP = "1";
process.env.DATA_DIR = join(directory, "data");
const { saveSettings } = await import("../apps/server/src/store/settings.ts");
const { createApp } = await import("../apps/server/src/app.ts");
const { getSession, saveSession } =
  await import("../apps/server/src/store/sessions.ts");
const token = (await readFile("data/cloud-local/stack.env", "utf8")).match(
  /^MEMBER_TOKEN=(.+)$/m,
)![1]!;
const app = createApp();
const workspace = join(directory, "workspace");
await mkdir(workspace);
const scheduleIds: string[] = [];
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
) {
  const r = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:8797",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${await (r.status !== status ? r.clone().text() : Promise.resolve(""))}`,
  );
  return (await r.json()) as any;
}
try {
  await saveSettings({
    runtime: "pig",
    cloudBaseUrl: "http://127.0.0.1:8890",
    cloudToken: token,
    cloudMode: "remote",
    workspaceRoot: workspace,
    llmApiKey: "",
    codexApiKey: "",
  });
  const schedule = await request(
    "/api/automations",
    "POST",
    {
      name: "工作台接口验收",
      prompt: "写入并读回文件",
      executionTarget: "remote",
      schedule: null,
    },
    201,
  );
  scheduleIds.push(schedule.id);
  assert.ok(
    (await request("/api/automations")).automations.some(
      (a: any) => a.id === schedule.id,
    ),
  );
  const run = await request(
    `/api/automations/${schedule.id}/run`,
    "POST",
    {},
    202,
  );
  assert.ok(run.remoteRunId);
  await request(`/api/remote/v1/runs/${run.remoteRunId}/abort`, "POST");
  const session = await request("/api/sessions", "POST", {}, 201);
  await request(`/api/sessions/${session.id}`, "PATCH", {
    executionTarget: "remote",
    engine: "pig",
  });
  const response = await app.request(`/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:8797",
    },
    body: JSON.stringify({
      content: "写入并读回文件",
      clientMessageId: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  // Disconnect the client immediately. The run and persisted result must survive.
  await response.body!.cancel();
  const end = Date.now() + 45000;
  let completed;
  while (Date.now() < end) {
    const current = await getSession(session.id);
    if (current?.remoteState === "succeeded") {
      completed = current;
      break;
    }
    if (current?.lastError) throw Error(current.lastError);
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(completed?.remoteRunId, "remote run survives detached stream");
  assert.ok(
    completed.messages.some(
      (m) => m.role === "assistant" && m.content.includes("容器执行验收通过"),
    ),
  );
  assert.equal(completed.messages.filter((m) => m.role === "user").length, 1);
  // Simulate the local process dying before it persisted the final transcript.
  await saveSession({
    ...completed,
    status: "running",
    remoteState: "running",
    messages: completed.messages.filter((m) => m.role === "user"),
    artifacts: [],
  });
  const recovered = await request(`/api/sessions/${session.id}`);
  assert.equal(recovered.remoteState, "succeeded");
  assert.equal(recovered.status, "idle");
  assert.ok(
    recovered.messages.some(
      (m: any) =>
        m.role === "assistant" && m.content.includes("容器执行验收通过"),
    ),
  );
  const again = await request(`/api/sessions/${session.id}`);
  assert.equal(
    again.messages.length,
    recovered.messages.length,
    "event replay must not duplicate messages",
  );
  assert.ok(
    (
      await request(`/api/remote/v1/runs/${completed.remoteRunId}/artifacts`)
    ).artifacts.some((f: any) => f.path === "cloud-proof.txt"),
  );
  // Retry a confirmed cancelled run as a fresh attempt, without changing user message identity.
  const cancelled=await request(`/api/remote/v1/runs/${run.remoteRunId}`);
  assert.equal(cancelled.state,"cancelled");
  await saveSession({...completed,status:"idle",remoteRunId:run.remoteRunId,remoteState:"cancelled"});
  const retry=await app.request(`/api/sessions/${session.id}/retry`,{method:"POST",headers:{Origin:"http://127.0.0.1:8797"}});
  assert.equal(retry.status,200);await retry.text();
  const retried=await getSession(session.id);
  assert.equal(retried?.remoteState,"succeeded");
  assert.notEqual(retried?.remoteRunId,completed.remoteRunId);
  assert.notEqual(retried?.remoteRunId,run.remoteRunId);
  assert.ok(retried?.remoteRequestKey);
  console.log(
    "PASS: unified workbench remote schedule CRUD/run, per-session location, disconnected client survival, authoritative recovery and deduplicated transcript/artifacts",
  );
} finally {
  for (const id of scheduleIds)
    await request(`/api/automations/${id}`, "DELETE").catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
