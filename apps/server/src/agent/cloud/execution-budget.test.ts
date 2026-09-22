import { describe, it, expect, vi } from "vitest";
import { ExecutionBudget } from "./execution-budget.ts";
describe("cloud execution budget", () => {
  it("pauses only execution budget during bounded approval", () => {
    vi.useFakeTimers();
    try {
      const budget = new ExecutionBudget(1000, new AbortController().signal);
      vi.advanceTimersByTime(400);
      const resume = budget.pauseForApproval(5000);
      vi.advanceTimersByTime(3000);
      expect(budget.signal.aborted).toBe(false);
      resume();
      resume();
      vi.advanceTimersByTime(599);
      expect(budget.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(budget.signal.aborted).toBe(true);
      budget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds approval waits and cancellation remains live", () => {
    vi.useFakeTimers();
    try {
      const cancel = new AbortController();
      const budget = new ExecutionBudget(1000, cancel.signal);
      budget.pauseForApproval(5000);
      vi.advanceTimersByTime(5000);
      expect(budget.signal.aborted).toBe(true);
      budget.dispose();
      const other = new ExecutionBudget(1000, cancel.signal);
      other.pauseForApproval();
      cancel.abort();
      expect(other.signal.aborted).toBe(true);
      other.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
