/**
 * Task-level evals: run the real agent loop end to end in a throwaway workspace and grade
 * outcomes deterministically. Reports success rate, model calls, tool calls, tokens,
 * prompt-cache hit rate and latency per case so harness changes can be compared.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Session, Settings } from "../../types.ts";
import { runAgent } from "../runtime.ts";
import { readDebugTrace, dropDebugSession } from "../debug-trace.ts";
import type { TaskCase } from "./task-cases.ts";

export type TaskResult = {
  id: string; pass: boolean; checks: Array<{ name: string; pass: boolean }>; error?: string;
  modelCalls: number; toolCalls: number; promptTokens: number; completionTokens: number; cachedTokens: number; cacheHitRate: number | null; ms: number; reply: string;
};

export async function runTaskCase(c: TaskCase, settings: Omit<Settings, "workspaceRoot">, opts: { runOptions?: Record<string, unknown> } = {}): Promise<TaskResult> {
  const root = mkdtempSync(join(tmpdir(), `pig-eval-${c.id}-`));
  for (const [p, content] of Object.entries(c.files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), content); }
  const started = Date.now();
  let session: Session = { id: `ses_eval_${c.id}_${started.toString(36)}`, title: c.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle", messages: [], steps: [], artifacts: [] } as Session;
  let error: string | undefined;
  try {
    for (const [i, prompt] of (Array.isArray(c.prompt) ? c.prompt : [c.prompt]).entries()) {
      session = { ...session, messages: [...session.messages, { id: `u${i}`, role: "user", content: prompt, createdAt: new Date().toISOString() }] };
      session = await runAgent({ session, settings: { ...settings, workspaceRoot: root } as Settings, signal: AbortSignal.timeout(180_000), emit: () => {}, memoryPins: [], ...(opts.runOptions ?? {}) });
      if (session.lastError) error = session.lastError;
    }
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  const ms = Date.now() - started;
  const reply = [...session.messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
  const tools = session.messages.flatMap((m) => m.toolCalls ?? []).map((t) => t.name);
  const checks = c.checks.map((k) => { try { return { name: k.name, pass: k.pass({ root, reply, tools }) }; } catch { return { name: k.name, pass: false }; } });
  const spans = (readDebugTrace(session.id) as { spans?: Array<{ kind: string; detail?: any }> })?.spans ?? [];
  const models = spans.filter((s) => s.kind === "model");
  const sum = (f: (d: any) => number | undefined) => models.reduce((n, s) => n + (f(s.detail) ?? 0), 0);
  const promptTokens = sum((d) => d?.usage?.prompt_tokens);
  const cachedTokens = sum((d) => d?.cache?.cachedTokens ?? undefined);
  dropDebugSession(session.id);
  rmSync(root, { recursive: true, force: true });
  return {
    id: c.id, pass: !error && checks.every((k) => k.pass), checks, error,
    modelCalls: models.length, toolCalls: tools.length, promptTokens, completionTokens: sum((d) => d?.usage?.completion_tokens),
    cachedTokens, cacheHitRate: promptTokens ? Math.round((cachedTokens / promptTokens) * 1000) / 1000 : null, ms, reply: reply.slice(0, 300),
  };
}

export function summarize(results: TaskResult[]) {
  const n = results.length || 1;
  const prompt = results.reduce((a, r) => a + r.promptTokens, 0);
  return {
    cases: results.length, passRate: Math.round((results.filter((r) => r.pass).length / n) * 1000) / 1000,
    avgModelCalls: +(results.reduce((a, r) => a + r.modelCalls, 0) / n).toFixed(2),
    avgToolCalls: +(results.reduce((a, r) => a + r.toolCalls, 0) / n).toFixed(2),
    promptTokens: prompt, completionTokens: results.reduce((a, r) => a + r.completionTokens, 0),
    cacheHitRate: prompt ? Math.round((results.reduce((a, r) => a + r.cachedTokens, 0) / prompt) * 1000) / 1000 : null,
    p50Ms: [...results].map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0,
  };
}

export function markdownTable(results: TaskResult[]): string {
  const rows = results.map((r) => `| ${r.id} | ${r.pass ? "✅" : "❌"} | ${r.modelCalls} | ${r.toolCalls} | ${r.promptTokens} | ${r.cacheHitRate ?? "-"} | ${(r.ms / 1000).toFixed(1)}s | ${r.error ? r.error.slice(0, 60) : r.checks.filter((k) => !k.pass).map((k) => k.name).join(", ")} |`);
  return ["| case | pass | model calls | tool calls | prompt tok | cache hit | time | notes |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}
