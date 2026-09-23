process.env.PIG_DESKTOP = "1";
for (const key of Object.keys(process.env)) {
  if (/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|PIG_CLOUD_|CLOUD_)/.test(key)) delete process.env[key];
}

import { createServer } from "node:http";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const task = process.argv[process.argv.indexOf("--task") + 1];
const mode = process.argv[process.argv.indexOf("--mode") + 1];
const samples = Number(process.argv[process.argv.indexOf("--samples") + 1] || 1);
const onlyIndex = process.argv.includes("--index") ? Number(process.argv[process.argv.indexOf("--index") + 1]) : 0;
const workspace = process.env.WORKSPACE_ROOT;
const requestedDelayMs = 30;

function emit(payload) {
  console.log(`BENCH ${JSON.stringify(payload)}`);
}

function assertToolProtocol(messages) {
  const pending = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      if (pending.length) throw new Error("tool calls started before the previous results finished");
      pending.push(...message.tool_calls.map((call) => call.id));
    } else if (message.role === "tool") {
      if (pending.shift() !== message.tool_call_id) throw new Error("tool message is not paired with a tool call");
    } else if (pending.length) {
      throw new Error("a non-tool message split a tool call from its result");
    }
  }
  if (pending.length) throw new Error("tool call has no result");
}

let api;
async function loadApi() {
  api ??= await (async () => {
    const runtime = await import("../apps/server/src/agent/runtime.ts");
    const events = await import("../apps/server/src/store/events.ts");
    const sessions = await import("../apps/server/src/store/sessions.ts");
    const settings = await import("../apps/server/src/store/settings.ts");
    const workbench = await import("../apps/server/src/store/workbench.ts");
    const app = await import("../apps/server/src/app.ts");
    return { ...runtime, ...events, ...sessions, ...settings, ...workbench, ...app };
  })();
  return api;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sse(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function runSample(index) {
  const loaded = await loadApi();
  const prepareStarted = Date.now();
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "bench\n");
  let modelWaitMs = 0;
  let captured = "";
  const pause = async (ms) => {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    modelWaitMs += Date.now() - started;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    captured = JSON.stringify(body);
    if (task === "cancel") {
      const blocked = Date.now();
      await new Promise((resolve) => res.once("close", resolve));
      modelWaitMs += Date.now() - blocked;
      return;
    }
    await pause(requestedDelayMs);
    const hasTool = (body.messages || []).some((message) => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (task === "stream" && !hasTool) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "流" }, finish_reason: null }] })}\n\n`);
      for (let i = 0; i < 6; i += 1) {
        await pause(5);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "式" }, finish_reason: null }] })}\n\n`);
      }
      res.end(sse([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 } }]));
      return;
    }
    const writes = !hasTool && task === "read"
      ? [{ id: `read-${index}`, name: "read_file", arguments: JSON.stringify({ path: "README.md" }) }]
      : !hasTool && task === "multi-write"
        ? [
            { id: `w1-${index}`, name: "write_file", arguments: JSON.stringify({ path: `one-${index}.txt`, content: "1" }) },
            { id: `w2-${index}`, name: "write_file", arguments: JSON.stringify({ path: `two-${index}.txt`, content: "2" }) },
          ]
        : !hasTool && task === "approvals"
          ? [
              { id: `a-${index}`, name: "write_file", arguments: JSON.stringify({ path: `approve-a-${index}.txt`, content: "A" }) },
              { id: `b-${index}`, name: "write_file", arguments: JSON.stringify({ path: `approve-b-${index}.txt`, content: "B" }) },
            ]
          : [];
    const delta = writes.length
      ? { tool_calls: writes.map((item, callIndex) => ({ index: callIndex, id: item.id, function: { name: item.name, arguments: item.arguments } })) }
      : { content: task === "long-context" ? "仍记得任务" : "好" };
    res.end(sse([
      { choices: [{ delta, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: writes.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const now = new Date().toISOString();
  const messages = task === "long-context"
    ? [
        { id: "goal", role: "user", content: "目标：交付周报。约束：不要改动锁文件。", createdAt: now },
        { id: "plan", role: "assistant", content: "", createdAt: now, toolCalls: [{ id: "plan-call", name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "核对标题", status: "pending" }] }) }] },
        { id: "approved", role: "tool", content: "已批准写入 report.md", toolCallId: "plan-call", createdAt: now },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `fat-${i}`, role: "user", content: `填充 ${"NOISE ".repeat(4000)}`, createdAt: now })),
      ]
    : [{ id: `u-${index}`, role: "user", content: task, createdAt: now }];
  const session = {
    id: `bench_${task}_${index}_${Date.now()}`,
    title: task,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    messages,
    steps: [],
    artifacts: [],
  };
  const settings = {
    llmBaseUrl: `http://127.0.0.1:${port}/v1`,
    llmApiKey: "bench",
    llmModel: "mock",
    workspaceRoot: workspace,
    runtime: "pig",
    codexBinaryPath: "",
    codexModel: "",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "",
    cloudMode: "local-stub",
  };
  let ttftMs = null;
  let firstToolMs = null;
  let writes = Promise.resolve();
  const prepareMs = Date.now() - prepareStarted;
  const started = Date.now();
  const controller = new AbortController();
  const noteTiming = (event) => {
    if (ttftMs === null && event.type === "token" && event.text) ttftMs = Date.now() - started;
    if (firstToolMs === null && event.type === "tool_start") firstToolMs = Date.now() - started;
  };
  const readSse = async (response) => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.startsWith("data:")) continue;
        try { noteTiming(JSON.parse(line.slice(5))); } catch { /* usage frames are not events */ }
      }
    }
  };
  try {
    if (task === "approvals") {
      await loaded.saveSettings(settings);
      const created = await loaded.createSession();
      const state = await loaded.loadWorkbench(created.id, workspace);
      state.policy.review = true;
      await loaded.saveWorkbench(created.id, state);
      const app = loaded.createApp();
      const posted = await app.request(`/api/sessions/${created.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "连续审批" }),
      });
      if (!posted.ok) throw new Error(await posted.text());
      await readSse(posted);
      const firstFile = join(workspace, `approve-a-${index}.txt`);
      const secondFile = join(workspace, `approve-b-${index}.txt`);
      if (await exists(firstFile) || await exists(secondFile)) throw new Error("a file existed before approval");
      const pending = await loaded.loadWorkbench(created.id, workspace);
      const first = pending.operations.find((op) => op.status === "pending");
      if (!first) throw new Error("the first approval was not waiting");
      const approved = await app.request(`/api/sessions/${created.id}/workbench/${first.id}/approve`, { method: "POST" });
      if (approved.status !== 200) throw new Error(await approved.text());
      if (await (await import("node:fs/promises")).readFile(firstFile, "utf8") !== "A") throw new Error("the first approved file is missing");
      if (await exists(secondFile)) throw new Error("the second file existed after only the first approval");
      const next = await loaded.loadWorkbench(created.id, workspace);
      const second = next.operations.find((op) => op.status === "pending");
      if (!second) throw new Error("the second approval was not waiting");
      const approvedSecond = await app.request(`/api/sessions/${created.id}/workbench/${second.id}/approve`, { method: "POST" });
      if (approvedSecond.status !== 200) throw new Error(await approvedSecond.text());
      if (await (await import("node:fs/promises")).readFile(secondFile, "utf8") !== "B") throw new Error("the second approved file is missing");
    } else if (task === "reconnect") {
      await loaded.saveSettings(settings);
      const created = await loaded.createSession();
      created.messages = messages;
      await loaded.saveSession(created);
      const result = await loaded.runAgent({
        session: created,
        settings,
        signal: controller.signal,
        emit: (event) => {
          noteTiming(event);
          writes = writes.then(() => loaded.publishPersistedEvent(created.id, event));
        },
      });
      await writes;
      await loaded.saveSession(result);
      const app = loaded.createApp();
      const readPage = async (after) => {
        const response = await app.request(`/api/sessions/${created.id}/events?live=0&after=${after}`);
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      };
      const all = await readPage(0);
      if (!Array.isArray(all.events) || all.events.length < 2) throw new Error("reconnect did not persist events");
      const cursor = all.events[Math.floor(all.events.length / 2) - 1].seq;
      const resumeStarted = performance.now();
      const rest = await readPage(cursor);
      const reconnectMs = Math.round((performance.now() - resumeStarted) * 10) / 10;
      const head = all.events.filter((event) => event.seq <= cursor);
      const combined = [...head, ...rest.events];
      const seqs = combined.map((event) => event.seq);
      if (new Set(seqs).size !== seqs.length) throw new Error("reconnect duplicated an event");
      if (rest.events.some((event) => event.seq <= cursor)) throw new Error("reconnect repeated events at the cursor");
      for (let i = 1; i < seqs.length; i += 1) if (seqs[i] !== seqs[i - 1] + 1) throw new Error("reconnect left a sequence gap");
      if (seqs.join(",") !== all.events.map((event) => event.seq).join(",")) throw new Error("reconnect did not cover the original log");
      return finish(prepareMs, started, ttftMs, firstToolMs, modelWaitMs, reconnectMs, ["events resume without gaps or duplicates"]);
    } else {
      if (task === "cancel") setTimeout(() => controller.abort(), requestedDelayMs + 20);
      const result = await loaded.runAgent({
        session,
        settings,
        signal: controller.signal,
        emit: noteTiming,
      });
      if (task === "short") {
        if (ttftMs === null) throw new Error("short reply had no text token");
        if (!result.messages.some((message) => message.content === "好")) throw new Error("short reply was missing");
      }
      if (task === "stream") {
        if (ttftMs === null) throw new Error("stream had no text token");
        const text = result.messages.map((message) => message.content).join("");
        if (!text.includes("流") || !text.includes("式")) throw new Error("stream text was incomplete");
      }
      if (task === "read") {
        const tool = result.messages.find((message) => message.toolCallId === `read-${index}`);
        if (!tool?.content.includes("bench")) throw new Error("read did not return the file");
        if (tool.toolOk === false) throw new Error(tool.content);
      }
      if (task === "multi-write") {
        const tools = result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId);
        if (tools.join(",") !== `w1-${index},w2-${index}`) throw new Error(`write order changed: ${tools.join(",")}`);
        const { readFile } = await import("node:fs/promises");
        if (await readFile(join(workspace, `one-${index}.txt`), "utf8") !== "1") throw new Error("first write is missing");
        if (await readFile(join(workspace, `two-${index}.txt`), "utf8") !== "2") throw new Error("second write is missing");
      }
      if (task === "long-context") {
        const body = JSON.parse(captured);
        assertToolProtocol(body.messages.filter((message) => message.role !== "system"));
        if (!captured.includes("交付周报") || !captured.includes("不要改动锁文件") || !captured.includes("核对标题") || !captured.includes("已批准写入 report.md")) {
          throw new Error("long context dropped a required fact");
        }
        if (!result.messages.some((message) => message.content.includes("仍记得任务"))) throw new Error("long context did not finish");
      }
      if (task === "cancel") {
        if (result.status !== "idle") throw new Error(`cancel status ${result.status}`);
        if (!result.messages.some((message) => message.content.includes("已停止"))) throw new Error("cancel did not reach a stopped message");
        if (await exists(join(workspace, `cancel-${index}.txt`))) throw new Error("cancel wrote a file");
        if (ttftMs !== null) throw new Error("cancel forged a text token");
      }
    }
    if (task === "approvals" || task === "cancel") {
      if (ttftMs !== null) throw new Error(`${task} forged a text token`);
    }
    return finish(prepareMs, started, ttftMs, firstToolMs, modelWaitMs, null, [task]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function finish(prepareMs, started, ttftMs, firstToolMs, modelWaitMs, reconnectMs, assertions) {
  const totalMs = Date.now() - started;
  return {
    event: "sample",
    ok: true,
    task,
    startupMs: prepareMs,
    ttftMs,
    firstToolMs,
    totalMs,
    modelWaitMs,
    overheadMs: Math.max(0, totalMs - modelWaitMs),
    reconnectMs,
    assertions,
  };
}

try {
  await loadApi();
  emit({ event: "ready" });
  if (mode === "hot") {
    try {
      await runSample(1000);
      emit({ event: "warmup", ok: true });
    } catch (error) {
      emit({ event: "warmup", ok: false, error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
    for (let index = 0; index < samples; index += 1) {
      try {
        emit(await runSample(index));
      } catch (error) {
        emit({ event: "sample", ok: false, task, index, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    emit({ ...(await runSample(onlyIndex)), index: onlyIndex });
  }
} catch (error) {
  emit({ event: "sample", ok: false, task, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
