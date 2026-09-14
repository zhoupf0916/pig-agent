import { describe, expect, it } from "vitest";
import { mapCloudEvent, parseCloudSseData } from "./events.ts";

describe("mapCloudEvent", () => {
  it("passes pig-shaped events through", () => {
    expect(mapCloudEvent({ type: "token", text: "你好" })).toEqual([{ type: "token", text: "你好" }]);
    const steps = mapCloudEvent({
      type: "steps",
      steps: [{ id: "s1", title: "计划", status: "running" }],
    });
    expect(steps[0]).toMatchObject({ type: "steps" });
    const artifact = mapCloudEvent({
      type: "artifact",
      artifact: { path: "a.md", action: "created", updatedAt: "t" },
    });
    expect(artifact[0]).toMatchObject({ type: "artifact", artifact: { path: "a.md", action: "created" } });
  });

  it("maps neo-inspired aliases onto AgentEvents", () => {
    expect(mapCloudEvent({ type: "assistant.delta", text: "x" })).toEqual([{ type: "token", text: "x" }]);
    expect(mapCloudEvent({ type: "run.started" })).toEqual([{ type: "status", status: "running" }]);
    expect(mapCloudEvent({ type: "run.idle" })).toEqual([{ type: "status", status: "idle" }]);
    expect(mapCloudEvent({ type: "run.error", message: "boom" })).toEqual([{ type: "error", message: "boom" }]);

    const started = mapCloudEvent({
      type: "tool.started",
      id: "t1",
      name: "write_file",
      arguments: { path: "a.md" },
    });
    expect(started[0]).toMatchObject({ type: "tool_start", id: "t1", name: "write_file" });

    const finished = mapCloudEvent({
      type: "tool.finished",
      id: "t1",
      name: "write_file",
      ok: true,
      output: "ok",
      durationMs: 12,
    });
    expect(finished).toEqual([
      { type: "tool_end", id: "t1", name: "write_file", ok: true, output: "ok", durationMs: 12 },
    ]);

    const plan = mapCloudEvent({
      type: "plan.updated",
      steps: [{ title: "写报告", status: "pending" }],
    });
    expect(plan[0]?.type).toBe("steps");

    const art = mapCloudEvent({
      type: "artifact.upserted",
      path: "out.md",
      action: "created",
    });
    expect(art[0]).toMatchObject({ type: "artifact", artifact: { path: "out.md", action: "created" } });
  });

  it("drops unknown frames so a richer plane cannot break the UI", () => {
    expect(mapCloudEvent({ type: "neo.internal.heartbeat" })).toEqual([]);
    expect(mapCloudEvent(null)).toEqual([]);
    expect(mapCloudEvent("nope")).toEqual([]);
  });

  it("parses SSE data lines", () => {
    expect(parseCloudSseData('{"type":"token","text":"a"}')).toEqual({ type: "token", text: "a" });
    expect(parseCloudSseData("[DONE]")).toBeUndefined();
    expect(parseCloudSseData("not-json")).toBeUndefined();
  });
});
