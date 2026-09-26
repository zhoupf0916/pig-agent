import { expect, it } from "vitest";
import { summarizeRunTiming, type DebugTraceView } from "@pig-agent/contracts";
const base = { runId: "r", createdAt: "2026-09-26T00:00:00Z", firstClaimAt: "2026-09-26T00:00:01Z", startedAt: "2026-09-26T00:00:02Z", endAt: "2026-09-26T00:00:10Z", attempts: 1, recoveries: 0, traces: [] as DebugTraceView[] };
it("separates queue, preparation and end-to-end duration without adding overlapping spans", () => {
  expect(summarizeRunTiming(base)).toMatchObject({ queueMs: 1000, preparationMs: 1000, elapsedMs: 10000, inputTokens: null, partial: true });
});
it("counts model spans once per supplied attempt and excludes arbitrary error bodies", () => {
  const result = summarizeRunTiming({ ...base, traces: [{ sessionId: "r", contentEnabled: false, dropped: 0, spans: [{ id: "m", sessionId: "r", kind: "model", name: "model", status: "ok", startedAtMs: 0, durationMs: 50, detail: { ttftMs: 10, usage: { prompt_tokens: 20, completion_tokens: 4 }, request: "private body" } }] }] });
  expect(result).toMatchObject({ modelMs: 50, modelTtftMs: 10, inputTokens: 20, outputTokens: 4, partial: false });
  expect(JSON.stringify(result)).not.toContain("private body");
});
it("does not invent timing or usage when a Runner supplied no values", () => {
  expect(summarizeRunTiming({ ...base, startedAt: undefined, firstClaimAt: undefined })).toMatchObject({ queueMs: null, preparationMs: null, modelTtftMs: null, inputTokens: null });
});
