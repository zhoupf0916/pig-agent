import { runningTurns } from "../agent/turn.ts";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createSession, getSession, saveSession } from "../store/sessions.ts";
import { saveSettings } from "../store/settings.ts";
import { applyOperation, loadWorkbench, saveWorkbench, stageOperation, undoOperation, locked } from "../store/workbench.ts";
import { dropDebugSession, readDebugTrace } from "../agent/debug-trace.ts";

let root: string;
let requests = 0;
let nextBatch: Array<{id: string; name: string; args: unknown}> | undefined;
let history: Array<{ role: string; content: string; tool_call_id?: string }> = [];
const llm = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); history = body.messages;
  requests++;
  const batch = nextBatch; nextBatch = undefined;
  const delta = batch ? { tool_calls: batch.map((call,index) => ({index,id:call.id,type:"function",function:{name:call.name,arguments:JSON.stringify(call.args)}})) } : requests === 1 ? { tool_calls: [{ index: 0, id: "delivery_call", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "delivery.txt", content: "verified" }) } }] } : { content: "已读取执行记录，修改已批准。" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
});
const app = createApp();
async function post(path: string, body?: unknown) { return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }); }
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pig-workbench-"));
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const address = llm.address(); if (!address || typeof address === "string") throw new Error("address");
  await saveSettings({ workspaceRoot: root, runtime: "pig", llmApiKey: "test", llmBaseUrl: `http://127.0.0.1:${address.port}` });
});
afterAll(async () => { llm.closeAllConnections(); await new Promise<void>((resolve) => llm.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

describe("delivery review and recovery", () => {
  it("pauses before writing, approves once, preserves history on continue and records provider usage", async () => {
    const session = await createSession();
    const policy = await loadWorkbench(session.id, root);
    policy.policy.review = true;
    await saveWorkbench(session.id, policy);
    const response = await post(`/api/sessions/${session.id}/messages`, { content: "write a file" });
    expect(response.status).toBe(200); await response.text();
    await expect(readFile(join(root, "delivery.txt"))).rejects.toThrow();
    const state = await loadWorkbench(session.id, root);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]?.status).toBe("pending");
    expect(state.usage).toMatchObject({ calls: 1, input: 100, output: 20, estimated: false });
    expect((await getSession(session.id))?.status).toBe("idle");
    const path = `/api/sessions/${session.id}/workbench/${state.operations[0]!.id}/approve`;
    const both = await Promise.all([post(path), post(path)]);
    expect(both.map((r) => r.status).sort()).toEqual([200,409]);
    expect(await readFile(join(root, "delivery.txt"), "utf8")).toBe("verified");
    expect((await post(path)).status).toBe(409);
    // Approval automatically continues from the durable checkpoint.
    expect((await getSession(session.id))?.status).toBe("idle");
    expect(history.some((m) => m.role === "tool" && m.tool_call_id === "delivery_call" && m.content.startsWith("applied:"))).toBe(true);
    expect((await getSession(session.id))?.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect((await loadWorkbench(session.id, root)).usage.calls).toBe(2);
    const undo = await post(`/api/sessions/${session.id}/workbench/${state.operations[0]!.id}/undo`);
    expect(undo.status).toBe(200); await expect(readFile(join(root, "delivery.txt"))).rejects.toThrow();
  });
  it("closes the waiting approval span after the queued write is approved", async () => {
    const session = await createSession();
    dropDebugSession(session.id);
    const policy = await loadWorkbench(session.id, root);
    policy.policy.review = true;
    await saveWorkbench(session.id, policy);
    nextBatch = [{ id: "span-approve", name: "write_file", args: { path: "span-approve.txt", content: "yes" } }];
    await (await post(`/api/sessions/${session.id}/messages`, { content: "approve span" })).text();
    const staged = readDebugTrace(session.id).spans.find((span) => span.id === "span-approve");
    expect(staged?.status).toBe("running");
    const state = await loadWorkbench(session.id, root);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await post(`/api/sessions/${session.id}/workbench/${state.operations[0]!.id}/approve`)).status).toBe(200);
    const trace = readDebugTrace(session.id);
    const closed = trace.spans.find((span) => span.id === "span-approve");
    expect(closed?.status).toBe("ok");
    expect(closed?.durationMs).toBeGreaterThan((staged?.durationMs ?? 0) + 50);
    expect(String(closed?.detail?.output)).toContain("Created span-approve.txt");
    expect(trace.spans.some((span) => span.status === "running")).toBe(false);
    expect(await readFile(join(root, "span-approve.txt"), "utf8")).toBe("yes");
  });
  it("closes the waiting approval span when the queued write is rejected and does not write", async () => {
    const session = await createSession();
    dropDebugSession(session.id);
    const policy = await loadWorkbench(session.id, root);
    policy.policy.review = true;
    await saveWorkbench(session.id, policy);
    nextBatch = [
      { id: "span-reject", name: "write_file", args: { path: "span-reject.txt", content: "no" } },
      { id: "span-later", name: "write_file", args: { path: "span-later.txt", content: "no" } },
    ];
    await (await post(`/api/sessions/${session.id}/messages`, { content: "reject span" })).text();
    const state = await loadWorkbench(session.id, root);
    expect((await post(`/api/sessions/${session.id}/workbench/${state.operations[0]!.id}/reject`)).status).toBe(200);
    const trace = readDebugTrace(session.id);
    expect(trace.spans.find((span) => span.id === "span-reject")?.status).toBe("cancelled");
    expect(trace.spans.some((span) => span.status === "running")).toBe(false);
    await expect(readFile(join(root, "span-reject.txt"))).rejects.toThrow();
    await expect(readFile(join(root, "span-later.txt"))).rejects.toThrow();
  });
  it("writes inside the sandbox without asking", async () => {
    const session = await createSession();
    nextBatch = [{ id: "auto_write", name: "write_file", args: { path: "auto.txt", content: "verified" } }];
    await (await post(`/api/sessions/${session.id}/messages`, { content: "write a file" })).text();
    expect(await readFile(join(root, "auto.txt"), "utf8")).toBe("verified");
    expect((await loadWorkbench(session.id, root)).operations[0]?.status).toBe("applied");
  });
  it("blocks at one operation, persists the remaining batch and resumes it exactly once", async () => {
    const session = await createSession();
    const policy = await loadWorkbench(session.id, root);
    policy.policy.review = true;
    await saveWorkbench(session.id, policy);
    nextBatch = [
      { id: "serial-first", name: "write_file", args: { path: "serial.txt", content: "first" } },
      { id: "serial-second", name: "edit_file", args: { path: "serial.txt", old_string: "first", new_string: "second" } },
      { id: "serial-read", name: "read_file", args: { path: "serial.txt" } },
    ];
    await (await post(`/api/sessions/${session.id}/messages`, { content: "serial approval" })).text();
    let state = await loadWorkbench(session.id, root);
    expect(state.operations).toHaveLength(1);
    expect(state.checkpoint?.calls.map((c) => c.id)).toEqual(["serial-second", "serial-read"]);
    expect((await getSession(session.id))?.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    const calls = requests;
    expect((await post(`/api/sessions/${session.id}/workbench/${state.operations[0]!.id}/approve`)).status).toBe(200);
    state = await loadWorkbench(session.id, root);
    expect(requests).toBe(calls); // The persisted batch resumes without another model request.
    expect(state.operations.map((op) => op.status)).toEqual(["applied", "pending"]);
    expect(await readFile(join(root, "serial.txt"), "utf8")).toBe("first");
    const path = `/api/sessions/${session.id}/workbench/${state.operations[1]!.id}/approve`;
    const attempts = await Promise.all([post(path), post(path)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await readFile(join(root, "serial.txt"), "utf8")).toBe("second");
    expect(requests).toBe(calls + 1);
    const saved = (await getSession(session.id))!;
    expect(saved.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["serial-first", "serial-second", "serial-read"]);
  });
  it("recovers an applied checkpoint after a process restart without replaying its command", async () => {
    const session = await createSession();
    session.deliveryMode = true;
    const calls = [
      { id: "restart-applied", name: "write_file", arguments: JSON.stringify({ path: "restart.txt", content: "original" }) },
      { id: "restart-next", name: "edit_file", arguments: JSON.stringify({ path: "restart.txt", old_string: "original", new_string: "resumed" }) },
    ];
    session.messages.push({ id: "restart-goal", role: "user", content: "continue checkpoint", createdAt: new Date().toISOString() });
    session.messages.push({ id: "restart-assistant", role: "assistant", content: "", toolCalls: calls, createdAt: new Date().toISOString() });
    await saveSession(session);
    const state = await loadWorkbench(session.id, root);
    const op = await stageOperation(state, calls[0]!.id, "write_file", { path: "restart.txt", content: "original" });
    state.checkpoint = { calls, userMessageId: "restart-goal" };
    await applyOperation(session.id, state, op);
    state.policy.review = true;
    await saveWorkbench(session.id, state);
    // Simulates a process dying after the applied journal commit but before tool-result persistence.
    const count = requests;
    const recovery = await post(`/api/sessions/${session.id}/retry`); expect(recovery.status).toBe(200); await recovery.text();
    for (let n=0; n<100 && runningTurns.has(session.id); n++) await new Promise((resolve) => setTimeout(resolve,5));
    const recovered = await loadWorkbench(session.id, root);
    expect(recovered.operations.map((item) => item.status)).toEqual(["applied", "pending"]);
    expect(requests).toBe(count);
    expect((await getSession(session.id))?.messages.filter((m) => m.toolCallId === "restart-applied")).toHaveLength(1);
    expect(await readFile(join(root, "restart.txt"), "utf8")).toBe("original");
    await post(`/api/sessions/${session.id}/workbench/${recovered.operations[1]!.id}/reject`);
  });
  it.each(["reject", "abort"])("%s invalidates the blocked batch and never executes later operations", async (action) => {
    const session = await createSession();
    const policy = await loadWorkbench(session.id, root);
    policy.policy.review = true;
    await saveWorkbench(session.id, policy);
    nextBatch = [{ id: `stop-${action}`, name: "write_file", args: { path: `stop-${action}.txt`, content: "bad" } }, { id: `later-${action}`, name: "write_file", args: { path: `later-${action}.txt`, content: "bad" } }];
    await (await post(`/api/sessions/${session.id}/messages`, { content: "stop approval" })).text();
    const state = await loadWorkbench(session.id, root);
    const op = state.operations[0]!;
    expect((await post(action === "abort" ? `/api/sessions/${session.id}/abort` : `/api/sessions/${session.id}/workbench/${op.id}/reject`)).status).toBe(200);
    expect((await post(`/api/sessions/${session.id}/workbench/${op.id}/approve`)).status).toBe(409);
    expect((await post(`/api/sessions/${session.id}/retry`)).status).toBe(409);
    await expect(readFile(join(root, `stop-${action}.txt`))).rejects.toThrow();
    await expect(readFile(join(root, `later-${action}.txt`))).rejects.toThrow();
  });
  it("blocks approval and undo if disk content changed externally", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    await writeFile(join(root, "conflict.txt"), "one");
    const op = await stageOperation(state, "conflict", "write_file", { path: "conflict.txt", content: "two" });
    await writeFile(join(root, "conflict.txt"), "outside");
    await expect(applyOperation(session.id, state, op)).rejects.toThrow("已变化");
    expect(await readFile(join(root, "conflict.txt"), "utf8")).toBe("outside");
    await writeFile(join(root, "conflict.txt"), "one"); await applyOperation(session.id, state, op);
    await writeFile(join(root, "conflict.txt"), "three"); await expect(undoOperation(session.id, state, op)).rejects.toThrow("已变化");
  });
  it("restores exact binary content for move and delete, and previews edits and patches", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    const binary = Buffer.from([0,1,255,17]); await writeFile(join(root, "binary.dat"), binary);
    const move = await stageOperation(state, "move", "move_file", { from: "binary.dat", to: "moved.dat" });
    await applyOperation(session.id, state, move); await undoOperation(session.id, state, move);
    expect(await readFile(join(root, "binary.dat"))).toEqual(binary);
    const del = await stageOperation(state, "delete", "delete_file", { path: "binary.dat" });
    await applyOperation(session.id, state, del); await undoOperation(session.id, state, del);
    expect(await readFile(join(root, "binary.dat"))).toEqual(binary);
    await writeFile(join(root, "edit.txt"), "first\n");
    const edit = await stageOperation(state, "edit", "edit_file", { path: "edit.txt", old_string: "first", new_string: "second" });
    expect(Buffer.from(edit.after[0]!.data!, "base64").toString()).toBe("second\n");
    await applyOperation(session.id, state, edit);
    const patch = await stageOperation(state, "patch", "apply_patch", { path: "edit.txt", replacements: [{ old_string: "second", new_string: "third" }] });
    await applyOperation(session.id, state, patch); expect(await readFile(join(root,"edit.txt"),"utf8")).toBe("third\n");
  });
  it("rejects paths outside the workspace and symlink escapes", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    await expect(stageOperation(state, "outside", "write_file", { path: "../outside.txt", content: "bad" })).rejects.toThrow();
    await symlink(tmpdir(), join(root,"escape"));
    await expect(stageOperation(state, "link", "write_file", { path: "escape/outside.txt", content: "bad" })).rejects.toThrow();
  });
  it("blocks new model requests once call budget is exhausted", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    state.policy.maxCalls = 1; state.usage.calls = 1; await saveWorkbench(session.id, state);
    const before = requests;
    await (await post(`/api/sessions/${session.id}/messages`, { content: "do something" })).text();
    expect(requests).toBe(before); expect((await getSession(session.id))?.lastError).toContain("预算");
  });
  it("uploads binary files without overwrites and supports undo", async () => {
    const session = await createSession(); const binary = new Uint8Array([0,255,2]);
    const form = new FormData(); form.append("file", new File([binary], "example.bin"));
    const response = await app.request(`/api/sessions/${session.id}/upload`, { method: "POST", body: form });
    expect(response.status).toBe(200); const { path } = await response.json() as { path: string };
    expect(await readFile(join(root,path))).toEqual(Buffer.from(binary));
    const state = await loadWorkbench(session.id, root); await undoOperation(session.id,state,state.operations[0]!);
    await expect(readFile(join(root,path))).rejects.toThrow();
  });
  it("does not re-execute an interrupted applying operation", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    const op = await stageOperation(state,"interrupted","run_shell",{command:"echo unknown"}); op.status="applying"; await saveWorkbench(session.id,state);
    session.messages.push({id:"goal",role:"user",content:"continue",createdAt:new Date().toISOString()}); await saveSession(session);
    expect((await post(`/api/sessions/${session.id}/retry`)).status).toBe(409);
    expect((await post(`/api/sessions/${session.id}/workbench/${op.id}/approve`)).status).toBe(409);
  });
  it("rejects a queued write without touching disk and binds approval to the original workspace", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id, root);
    const op = await stageOperation(state,"root-check","write_file",{path:"root-check.txt",content:"no"}); await saveWorkbench(session.id,state);
    const other = await mkdtemp(join(tmpdir(),"pig-other-"));
    try {
      await saveSettings({workspaceRoot:other});
      expect((await post(`/api/sessions/${session.id}/workbench/${op.id}/approve`)).status).toBe(409);
      expect((await post(`/api/sessions/${session.id}/workbench/${op.id}/reject`)).status).toBe(200);
      await expect(readFile(join(root,"root-check.txt"))).rejects.toThrow();
      await expect(readFile(join(other,"root-check.txt"))).rejects.toThrow();
    } finally { await saveSettings({workspaceRoot:root}); await rm(other,{recursive:true,force:true}); }
  });
  it("enforces a configured cost limit before making the next request", async () => {
    const session = await createSession(); const state = await loadWorkbench(session.id,root);
    state.policy.maxCost=1; state.policy.inputPrice=1; state.usage.cost=1; await saveWorkbench(session.id,state);
    const before=requests; await (await post(`/api/sessions/${session.id}/messages`,{content:"budget"})).text();
    expect(requests).toBe(before); expect((await getSession(session.id))?.lastError).toContain("预算");
  });
  it("repairs interrupted tool protocol without replaying the tool", async () => {
    const session=await createSession();
    session.messages=[{id:"user",role:"user",content:"inspect",createdAt:"now"},{id:"assistant",role:"assistant",content:"",createdAt:"now",toolCalls:[{id:"lost-read",name:"read_file",arguments:'{"path":"unknown"}'}]}];
    session.status="running"; await saveSession(session);
    await (await post(`/api/sessions/${session.id}/retry`)).text();
    expect(history.find((m)=>m.tool_call_id==="lost-read")?.content).toContain("结果未知");
    expect((await getSession(session.id))?.messages.filter((m)=>m.toolCallId==="lost-read")).toHaveLength(1);
  });
  it("can stop an approved long-running command and requires review after interruption", async () => {
    const session=await createSession(); const state=await loadWorkbench(session.id,root);
    const op=await stageOperation(state,"slow","run_shell",{command:"sleep 20"}); await saveWorkbench(session.id,state);
    const approval=post(`/api/sessions/${session.id}/workbench/${op.id}/approve`);
    for(let i=0;i<100 && !runningTurns.has(session.id);i++) await new Promise((resolve)=>setTimeout(resolve,10));
    expect(runningTurns.has(session.id)).toBe(true);
    expect((await post(`/api/sessions/${session.id}/abort`)).status).toBe(200);
    expect((await approval).status).toBe(409);
    expect((await loadWorkbench(session.id,root)).operations[0]?.status).toBe("error");
  });
  it("persists custom templates", async () => {
    const added = await post("/api/workbench/templates",{name:"我的模板",prompt:"检查资料"}); expect(added.status).toBe(200);
    const item = await added.json() as { id: string; name: string; prompt: string }; const list = await (await app.request("/api/workbench/templates")).json(); expect(list).toContainEqual(item);
    await app.request(`/api/workbench/templates/${item.id}`,{method:"DELETE"}); expect(await (await app.request("/api/workbench/templates")).json()).not.toContainEqual(item);
  });
  it("rejects concurrent mutation locks", async () => {
    await locked("lock-test",async()=>{ await expect(locked("lock-test",async()=>{})).rejects.toThrow("另一项操作"); });
  });
});

it("persists an explicit upload receipt without representing it as a new question", async () => {
  const session = await createSession();
  const form = new FormData(); form.append('file',new File(['evidence'],'input.txt',{type:'text/plain'}));
  const response = await createApp().request(`/api/sessions/${session.id}/upload`,{method:'POST',body:form});
  expect(response.status).toBe(200);
  const saved=await getSession(session.id);
  expect(saved?.messages.at(-1)).toMatchObject({synthetic:'attachment',role:'user'});
  expect(saved?.messages.at(-1)?.content).toContain('input.txt');
});

it('records a durable cancellation answer once when stopping a waiting approval', async () => {
  const session=await createSession();
  const policy=await loadWorkbench(session.id,root);policy.policy.review=true;await saveWorkbench(session.id,policy);
  nextBatch=[{id:'cancel-answer',name:'write_file',args:{path:'cancel-answer.txt',content:'no'}}];
  const app=createApp();
  await (await app.request(`/api/sessions/${session.id}/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'取消等待审批'})})).text();
  await app.request(`/api/sessions/${session.id}/abort`,{method:'POST'});
  await app.request(`/api/sessions/${session.id}/abort`,{method:'POST'});
  expect((await getSession(session.id))?.messages.filter(m=>m.role==='assistant'&&m.content.startsWith('已停止'))).toHaveLength(1);
  await expect(readFile(join(root,'cancel-answer.txt'))).rejects.toThrow();
});
