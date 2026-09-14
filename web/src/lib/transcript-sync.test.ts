import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  applySyncPhase,
  CATCH_UP_STATUS,
  rememberEventSeq,
  sessionEventsSubscribeInit,
} from "./transcript-sync";

describe("transcript SSE reconnect cursor", () => {
  it("reconnects with after + Last-Event-ID only (no full-history snapshot)", () => {
    const init = sessionEventsSubscribeInit(7);
    expect(init.query).toBe("after=7");
    expect(init.headers["Last-Event-ID"]).toBe("7");
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(init.query.includes("snapshot")).toBe(false);
    expect(init.query.includes("replay=all")).toBe(false);
  });

  it("never rewinds the exclusive cursor after a seq has been seen", () => {
    expect(rememberEventSeq(0, 3)).toBe(3);
    expect(rememberEventSeq(5, 2)).toBe(5);
    expect(rememberEventSeq(5, undefined)).toBe(5);
  });

  it("surfaces catch-up only for a non-empty gap, then returns to idle", () => {
    const catching = applySyncPhase(
      { type: "sync", phase: "catching_up", after: 3, lastSeq: 5, gap: 2 },
      "idle",
    );
    expect(catching).toBe("catching_up");
    expect(CATCH_UP_STATUS).toBe("正在追平未送达事件…");
    expect(redactSecretsForDisplay(CATCH_UP_STATUS)).toBe(CATCH_UP_STATUS);

    const live = applySyncPhase(
      { type: "sync", phase: "live", after: 3, lastSeq: 5, gap: 0 },
      "catching_up",
    );
    expect(live).toBe("idle");

    const emptyGap = applySyncPhase(
      { type: "sync", phase: "catching_up", after: 5, lastSeq: 5, gap: 0 },
      "idle",
    );
    expect(emptyGap).toBe("idle");
  });
});
