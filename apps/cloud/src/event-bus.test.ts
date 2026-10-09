import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.ts";
import { heartbeatDue, longPollMs } from "./stream-timing.ts";

const live = () => Object.assign(new EventBus(undefined), { live: true });

describe("event bus subscriptions", () => {
  it("wakes a waiting subscriber with the keys that fired", async () => {
    const bus = live();
    const sub = bus.subscribe(["run:a", "auth"]);
    const started = Date.now();
    const waiting = sub.wait({ liveMs: 5000, pollMs: 100 });
    bus.dispatch("run:a");
    expect([...(await waiting)]).toEqual(["run:a"]);
    expect(Date.now() - started).toBeLessThan(1000);
    sub.close();
  });

  it("does not lose a notification that arrives between reads", async () => {
    const bus = live();
    const sub = bus.subscribe(["ev:a"]);
    bus.dispatch("ev:a"); // while the stream was busy querying
    const fired = await sub.wait({ liveMs: 5000, pollMs: 100 });
    expect(fired.has("ev:a")).toBe(true);
    sub.close();
  });

  it("ignores other keys and times out with an empty set", async () => {
    const bus = live();
    const sub = bus.subscribe(["run:a"]);
    const waiting = sub.wait({ liveMs: 30, pollMs: 10_000 });
    bus.dispatch("run:b");
    expect((await waiting).size).toBe(0);
    sub.close();
  });

  it("falls back to the polling interval while the bus is down", async () => {
    const bus = new EventBus(undefined);
    const sub = bus.subscribe(["run:a"]);
    const started = Date.now();
    await sub.wait({ liveMs: 10_000, pollMs: 20 });
    expect(Date.now() - started).toBeLessThan(1000);
    sub.close();
  });

  it("returns early on abort and unsubscribes on close", async () => {
    const bus = live();
    const sub = bus.subscribe(["run:a", "auth"]);
    const abort = new AbortController();
    const waiting = sub.wait({ liveMs: 10_000, pollMs: 10_000, signal: abort.signal });
    abort.abort();
    await waiting;
    expect(bus.subscribers).toBe(2); // one registration per key
    sub.close();
    expect(bus.subscribers).toBe(0);
  });
});

describe("stream timing helpers", () => {
  it("parses and caps the long-poll header", () => {
    expect(longPollMs(undefined, 3000)).toBe(0);
    expect(longPollMs("abc", 3000)).toBe(0);
    expect(longPollMs("-5", 3000)).toBe(0);
    expect(longPollMs("1500", 3000)).toBe(1500);
    expect(longPollMs("999999", 3000)).toBe(3000);
  });
  it("treats a heartbeat timer that fires slightly early as due", () => {
    expect(heartbeatDue(0, 9_990)).toBe(true);
    expect(heartbeatDue(0, 5_000)).toBe(false);
  });
});
