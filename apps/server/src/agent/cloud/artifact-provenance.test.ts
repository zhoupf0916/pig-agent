import { describe, expect, it } from "vitest";
import { applyRemoteEvent } from "./remote.ts";
import type { Session } from "../../types.ts";
const session = (): Session => ({
  id: "s",
  title: "",
  createdAt: "",
  updatedAt: "",
  status: "idle",
  messages: [],
  steps: [],
  artifacts: [],
  remoteRunId: "run_current",
  executionTarget: "remote",
});
describe("remote event artifact identity", () => {
  it("tags streamed artifact snapshots with the owning run", () => {
    const current = session();
    applyRemoteEvent(current, {
      type: "artifact",
      artifact: { path: "same.txt", action: "created", updatedAt: "" },
    });
    expect(current.artifacts[0]?.source).toEqual({
      kind: "remote",
      runId: "run_current",
    });
  });
  it("tags legacy terminal snapshots without discarding explicit historical identity", () => {
    const current = session();
    applyRemoteEvent(current, {
      type: "done",
      session: {
        ...session(),
        artifacts: [
          { path: "same.txt", action: "created", updatedAt: "" },
          {
            path: "older.txt",
            action: "created",
            updatedAt: "",
            source: { kind: "remote", runId: "run_older", artifactId: "older" },
          },
        ],
      },
    });
    expect(current.artifacts[0]?.source).toEqual({
      kind: "remote",
      runId: "run_current",
    });
    expect(current.artifacts[1]?.source).toEqual({
      kind: "remote",
      runId: "run_older",
      artifactId: "older",
    });
  });
});
