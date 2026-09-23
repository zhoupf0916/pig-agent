import { describe, expect, it } from "vitest";
import { closeTerminalDebugTrace } from "@pig-agent/contracts";

describe("terminal runs close leftover debug spans", () => {
  it("does not leave an approval running after the run is cancelled", () => {
    const view = closeTerminalDebugTrace({
      sessionId: "run_cancelled",
      contentEnabled: true,
      dropped: 0,
      spans: [{
        id: "approval-1",
        sessionId: "run_cancelled",
        kind: "approval",
        name: "write_file",
        status: "running",
        startedAtMs: 1,
        detail: { sandboxEffective: "尚未执行" },
      }],
    }, "cancelled");
    expect(view.spans[0]?.status).toBe("cancelled");
    expect(view.spans.some((span) => span.status === "running")).toBe(false);
  });

  it("leaves a running approval visible while the run is still running", () => {
    const view = closeTerminalDebugTrace({
      sessionId: "run_live",
      contentEnabled: false,
      dropped: 0,
      spans: [{
        id: "approval-1",
        sessionId: "run_live",
        kind: "approval",
        name: "write_file",
        status: "running",
        startedAtMs: 1,
      }],
    }, "running");
    expect(view.spans[0]?.status).toBe("running");
  });
});
