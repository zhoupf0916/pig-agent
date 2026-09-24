import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import type { AgentEvent, Session, Settings } from "../types.ts";
import { loadWorkbench, saveWorkbench } from "../store/workbench.ts";
import { runAgent } from "./runtime.ts";

it("does not claim a new model context measurement when the call budget blocks execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pig-context-budget-review-"));
  const now = new Date().toISOString();
  const session: Session = {
    id: "ses_context_budget_review", title: "budget", createdAt: now, updatedAt: now,
    status: "idle", deliveryMode: true, steps: [], artifacts: [],
    messages: [{ id: "goal", role: "user", content: "检查说明", createdAt: now }],
  };
  const settings: Settings = {
    runtime: "pig", workspaceRoot: root, llmBaseUrl: "http://127.0.0.1:9/v1",
    llmApiKey: "test-key", llmModel: "mock", codexBinaryPath: "", codexModel: "",
    codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub",
  };
  const workbench = await loadWorkbench(session.id, root);
  workbench.policy.maxCalls = 0;
  await saveWorkbench(session.id, workbench);
  const events: AgentEvent[] = [];
  const result = await runAgent({ session, settings, signal: new AbortController().signal, emit: (event) => events.push(event), memoryPins: [] });
  expect(result.lastError).toContain("预算");
  expect(events.filter((event) => event.type === "context_usage")).toEqual([]);
  expect(result.lastContextUsage).toBeUndefined();
});
