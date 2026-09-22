import { afterEach, expect, it, vi } from "vitest";
import { EventBatcher } from "./event-batcher.ts";
afterEach(() => vi.useRealTimers());
it("sends first text immediately and combines subsequent text without loss", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const batch = new EventBatcher(send);
  batch.push({ type: "token", text: "你" });
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "token", text: "你" });
  batch.push({ type: "token", text: "好" });
  batch.push({ type: "token", text: "世界" });
  vi.advanceTimersByTime(60);
  expect(send.mock.calls.map(([e]) => e.text).join("")).toBe("你好世界");
  expect(send).toHaveBeenCalledTimes(2);
});
it("flushes before the authoritative message and begins the next turn immediately", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const batch = new EventBatcher(send);
  batch.push({ type: "token", text: "a" });
  batch.push({ type: "token", text: "b" });
  batch.push({ type: "message", message: { content: "ab" } });
  batch.push({ type: "token", text: "c" });
  vi.runAllTimers();
  expect(send.mock.calls.map(([e]) => e.type)).toEqual([
    "token",
    "token",
    "message",
    "token",
  ]);
  expect(send.mock.calls[1]![0].text).toBe("b");
});
it("bounded bursts flush without a timer and final drain does not duplicate", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const batch = new EventBatcher(send);
  batch.push({ type: "token", text: "a" });
  batch.push({ type: "token", text: "x".repeat(2048) });
  expect(send).toHaveBeenCalledTimes(2);
  batch.push({ type: "token", text: "z" });
  batch.flush();
  batch.flush();
  vi.runAllTimers();
  expect(send).toHaveBeenCalledTimes(3);
});
