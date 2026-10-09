import type { TaskResult } from "./task-eval.ts";

/**
 * Regression gate for the task eval. The committed baseline records, per case, which checks pass and how
 * many model/tool calls it took. A run regresses when a previously passing case or check fails, a case
 * disappears, or a case needs clearly more calls than before. Improvements are reported so the baseline
 * can be refreshed with `--write-baseline`.
 */
export type BaselineCase = { pass: boolean; checks: Record<string, boolean>; modelCalls: number; toolCalls: number };
export type Baseline = { version: 1; model: string; cases: Record<string, BaselineCase> };
export type GateReport = { ok: boolean; regressions: string[]; improvements: string[] };

export const CALL_SLACK = { model: 1, tool: 2 } as const;

export function toBaseline(results: TaskResult[], model: string): Baseline {
  const cases: Record<string, BaselineCase> = {};
  for (const r of results) {
    const id = r.id;
    const prev = cases[id];
    const checks = Object.fromEntries(r.checks.map((c) => [c.name, c.pass]));
    // With several trials keep the weakest observation so the gate stays deterministic-safe.
    cases[id] = prev
      ? {
          pass: prev.pass && r.pass,
          checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v && prev.checks[k] !== false])),
          modelCalls: Math.max(prev.modelCalls, r.modelCalls),
          toolCalls: Math.max(prev.toolCalls, r.toolCalls),
        }
      : { pass: r.pass, checks, modelCalls: r.modelCalls, toolCalls: r.toolCalls };
  }
  return { version: 1, model, cases: Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b))) };
}

export function compareToBaseline(results: TaskResult[], baseline: Baseline, opts: { partial?: boolean } = {}): GateReport {
  const current = toBaseline(results, baseline.model).cases;
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [id, base] of Object.entries(baseline.cases)) {
    const now = current[id];
    if (!now) {
      if (!opts.partial) regressions.push(`${id}: case missing from run`);
      continue;
    }
    if (base.pass && !now.pass) regressions.push(`${id}: passed in baseline, now fails`);
    if (!base.pass && now.pass) improvements.push(`${id}: now passes`);
    for (const [check, was] of Object.entries(base.checks)) {
      const is = now.checks[check];
      if (was && is !== true) regressions.push(`${id}: check "${check}" ${is === undefined ? "missing" : "now fails"}`);
      if (!was && is === true) improvements.push(`${id}: check "${check}" now passes`);
    }
    if (now.modelCalls > base.modelCalls + CALL_SLACK.model) regressions.push(`${id}: model calls ${base.modelCalls} -> ${now.modelCalls}`);
    if (now.toolCalls > base.toolCalls + CALL_SLACK.tool) regressions.push(`${id}: tool calls ${base.toolCalls} -> ${now.toolCalls}`);
  }
  for (const id of Object.keys(current)) if (!baseline.cases[id]) improvements.push(`${id}: new case (not in baseline)`);
  return { ok: regressions.length === 0, regressions, improvements };
}
