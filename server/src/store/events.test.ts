import { describe, expect, it } from "vitest";
import { appendSessionEvent, getLastEventSeq, readEventsAfter } from "./events.ts";
import { publishPersistedEvent } from "./events.ts";
import { subscribeSessionEvents } from "./bus.ts";
import { newId } from "../util.ts";

describe("session event log + bus", () => {
  it("appends monotonic seq and catch-up after works", async () => {
    const id = newId("ses");
    const a = await appendSessionEvent(id, { type: "status", status: "running" });
    const b = await appendSessionEvent(id, { type: "token", text: "hello" });
    const c = await appendSessionEvent(id, { type: "token", text: " world" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
    expect(await getLastEventSeq(id)).toBe(3);

    const missed = await readEventsAfter(id, 1);
    expect(missed.map((r) => r.seq)).toEqual([2, 3]);
    expect(missed.map((r) => (r.event.type === "token" ? r.event.text : ""))).toEqual([
      "hello",
      " world",
    ]);
  });

  it("fans the same sequence out to two subscribers", async () => {
    const id = newId("ses");
    const left: number[] = [];
    const right: number[] = [];
    const texts: [string[], string[]] = [[], []];
    const unsub1 = subscribeSessionEvents(id, (r) => {
      left.push(r.seq);
      if (r.event.type === "token") texts[0].push(r.event.text);
    });
    const unsub2 = subscribeSessionEvents(id, (r) => {
      right.push(r.seq);
      if (r.event.type === "token") texts[1].push(r.event.text);
    });

    await publishPersistedEvent(id, { type: "token", text: "A" });
    await publishPersistedEvent(id, { type: "token", text: "B" });
    await publishPersistedEvent(id, { type: "status", status: "idle" });

    expect(left).toEqual([1, 2, 3]);
    expect(right).toEqual([1, 2, 3]);
    expect(texts[0]).toEqual(["A", "B"]);
    expect(texts[1]).toEqual(["A", "B"]);
    unsub1();
    unsub2();
  });
});
