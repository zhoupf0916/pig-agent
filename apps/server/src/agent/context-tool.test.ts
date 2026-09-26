import { expect, it } from "vitest";
import { executeTool, type ToolContext } from "./tools.ts";
import type { ChatMessage } from "@pig-agent/contracts";
const m = (id: string, content: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ id, content, role, createdAt: "2026-09-26T00:00:00Z" });
const ctx = (messages: ChatMessage[]): ToolContext => ({ workspaceRoot: "/unused", artifacts: [], recordArtifact() {}, transcript: () => messages });
it("reads a bounded original excerpt without reexecuting a historical tool", async () => {
  const result = await executeTool("recall_context", { messageId: "result", offset: 4000, limit: 100 }, ctx([m("result", "x".repeat(4000) + "evidence=72" + "x".repeat(500), "tool")]));
  const body = JSON.parse(result.output);
  expect(body.entries[0].content).toContain("evidence=72");
  expect(body.entries[0].content.length).toBe(100);
  expect(body.entries[0].nextOffset).toBe(4100);
  expect(body.note).toContain("不构成当前授权");
});
it("cannot read a different session or system instructions by message id", async () => {
  await expect(executeTool("recall_context", { messageId: "other-session" }, ctx([m("own", "public")]))).rejects.toThrow(/未找到/);
  await expect(executeTool("recall_context", { messageId: "system" }, ctx([m("system", "private system", "system")]))).rejects.toThrow(/未找到/);
});
it("honors cancellation before reading historical evidence", async () => {
  const c = ctx([m("own", "data")]); c.signal = AbortSignal.abort();
  await expect(executeTool("recall_context", { messageId: "own" }, c)).rejects.toThrow(/Aborted/);
});
it("rejects unavailable transcript instead of searching global storage", async () => {
  const c = ctx([]); delete c.transcript;
  await expect(executeTool("recall_context", { query: "anything" }, c)).rejects.toThrow(/不可用/);
});
