import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "pig-cloud-adapter-"));
process.env.PIG_DESKTOP = "1";
process.env.DATA_DIR = join(directory, "data");
const { normalizeSettings } =
  await import("../apps/server/src/store/settings.ts");
const { runRemoteCloudAgent } =
  await import("../apps/server/src/agent/cloud/remote.ts");
const token = (await readFile("data/cloud-local/stack.env", "utf8")).match(
  /^MEMBER_TOKEN=(.+)$/m,
)![1]!;
try {
  await writeFile(join(directory, "input.txt"), "Adapter workspace upload");
  const settings = normalizeSettings({
    runtime: "cloud",
    cloudMode: "remote",
    cloudBaseUrl: "http://127.0.0.1:8890",
    cloudToken: token,
    workspaceRoot: directory,
    llmApiKey: "",
    codexApiKey: "",
  });
  const now = new Date().toISOString();
  const session = {
    id: "adapter-test",
    title: "Cloud adapter smoke",
    createdAt: now,
    updatedAt: now,
    status: "idle" as const,
    messages: [
      {
        id: "user",
        role: "user" as const,
        content: "创建并读回一个验收文件",
        createdAt: now,
      },
    ],
    steps: [],
    artifacts: [],
  };
  const result = await runRemoteCloudAgent({
    session,
    settings,
    signal: AbortSignal.timeout(45000),
    emit: () => {},
  });
  assert.equal(result.lastError, undefined);
  assert.equal(result.status, "idle");
  assert.ok(
    result.messages.some(
      (m) => m.role === "assistant" && m.content.includes("容器执行验收通过"),
    ),
  );
  assert.ok(result.artifacts.some((a) => a.path === "cloud-proof.txt"));
  const artifacts = (await fetch(
    `http://127.0.0.1:8890/v1/runs/${result.remoteRunId}/artifacts`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json())) as { artifacts: Array<{ path: string }> };
  assert.ok(artifacts.artifacts.some((f) => f.path === "input.txt"));
  console.log(
    "Existing Web/Electron remote adapter passed: workspace archive, authenticated run, SSE, final reply and artifact metadata.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
