import { expect, it } from "vitest";
import { executionJournal } from "./execution-journal";
import type { AgentEvent } from "../types";
it("reduces token transport and matching tool lifecycle into one meaningful operation without hiding errors", () => {
  const events: AgentEvent[] = [
    { type: "token", text: "hello" },
    {
      type: "tool_start",
      id: "a",
      name: "read_file",
      arguments: { path: "a" },
      startedAt: "",
    },
    {
      type: "tool_end",
      id: "a",
      name: "read_file",
      ok: false,
      output: "not found",
      durationMs: 1,
    },
    { type: "error", message: "connection failed" },
  ];
  const rows = executionJournal(events);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    detail: "not found",
    failed: true,
    running: false,
  });
  expect(rows[1]?.detail).toBe("connection failed");
});
it("retains pending tools and distinct invocations, including replayed end events", () => {
  const events: AgentEvent[] = [
    {
      type: "tool_end",
      id: "a",
      name: "read_file",
      ok: true,
      output: "one",
      durationMs: 1,
    },
    {
      type: "tool_end",
      id: "a",
      name: "read_file",
      ok: true,
      output: "one",
      durationMs: 1,
    },
    {
      type: "tool_start",
      id: "b",
      name: "read_file",
      arguments: {},
      startedAt: "",
    },
  ];
  expect(executionJournal(events).map((e) => e.running)).toEqual([false, true]);
});
