import { describe, expect, it } from "vitest";
import { backoffSeconds, claimMode, classifyFailure, eligibleOwnersSql, legacyCandidateSql, ownerCandidateSql } from "./queue.ts";
import { recoverInterruptedSql } from "./recovery.ts";

describe("queue retry policy", () => {
  it("backs off exponentially with jitter and a cap", () => {
    expect(backoffSeconds(0, () => 0.5)).toBe(10);
    expect(backoffSeconds(1, () => 0.5)).toBe(20);
    expect(backoffSeconds(2, () => 0.5)).toBe(40);
    expect(backoffSeconds(10, () => 0.5)).toBe(300);
    expect(backoffSeconds(0, () => 0)).toBe(8);
    expect(backoffSeconds(0, () => 1)).toBe(12);
  });
  it("retries only failures that happened before the runner started", () => {
    expect(classifyFailure({ started: false, error: "mkdir failed" })).toEqual({ errorClass: "prestart", retry: true, deadLetter: true });
    expect(classifyFailure({ started: true, error: "模型网关暂时无法连接上游服务" })).toEqual({ errorClass: "model_unavailable", retry: false, deadLetter: true });
    expect(classifyFailure({ started: true, error: "upstream returned 503" }).errorClass).toBe("model_unavailable");
    expect(classifyFailure({ started: true, error: "HTTP 429 rate limit" }).errorClass).toBe("model_unavailable");
    expect(classifyFailure({ started: true, error: "测试失败：断言不成立" })).toEqual({ errorClass: "task", retry: false, deadLetter: false });
    // A 3-digit number that is not an HTTP status must not be mistaken for one.
    expect(classifyFailure({ started: true, error: "processed 4290 rows" }).errorClass).toBe("task");
    expect(classifyFailure({ started: true, error: "超过 500 次模型调用上限" }).errorClass).toBe("task");
    expect(classifyFailure({ started: true, error: "port 502 is closed" }).errorClass).toBe("task");
    expect(classifyFailure({ started: true, error: "模型请求失败 (502)" }).errorClass).toBe("model_unavailable");
    expect(classifyFailure({ started: true, error: "LLM HTTP 503: overloaded" }).errorClass).toBe("model_unavailable");
    expect(classifyFailure({ started: true, error: "Cannot reach LLM at http://gateway:8891/v1. (fetch failed)" }).errorClass).toBe("model_unavailable");
  });
  it("keeps the legacy claim selectable by flag", () => {
    expect(claimMode(undefined)).toBe("fair");
    expect(claimMode("legacy")).toBe("legacy");
    expect(claimMode("anything")).toBe("fair");
  });
  it("respects retry delays in every claim path", () => {
    for (const sql of [ownerCandidateSql, legacyCandidateSql]) expect(sql).toContain("next_attempt_at<=now()");
    expect(ownerCandidateSql).toContain("FOR UPDATE OF r SKIP LOCKED");
    expect(eligibleOwnersSql).toContain("WITH RECURSIVE");
  });
  it("never requeues an attempt that may have run tools without a safe checkpoint", () => {
    expect(recoverInterruptedSql).toContain("started_at IS NULL AND attempt_count<");
    expect(recoverInterruptedSql).toContain("checkpoint_phase='safe' AND checkpoint IS NOT NULL AND recovery_count<2");
    expect(recoverInterruptedSql).toContain("dead_lettered_at=CASE WHEN state!='cancelling'");
  });
});
