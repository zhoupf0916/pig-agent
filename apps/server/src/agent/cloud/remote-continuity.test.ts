import { describe, it, expect } from "vitest";
import { runRemoteCloudAgent } from "./remote.ts";
import { normalizeSettings } from "../../store/settings.ts";
import type { Session } from "../../types.ts";
describe("control-plane follow-up recovery", () => {
  it("retries an uncertain follow-up with the same parent/key and subscribes to the returned new run", async () => {
    const session: Session = {
      id: "ses_follow",
      title: "follow",
      createdAt: "now",
      updatedAt: "now",
      status: "idle",
      messages: [
        { id: "user_next", role: "user", content: "next", createdAt: "now" },
      ],
      steps: [],
      artifacts: [],
      remoteRunId: "run_parent",
      remoteState: "succeeded",
    };
    const keys: string[] = [];
    let uncertain = true;
    const fetchImpl = (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/follow-ups")) {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") || "");
        if (uncertain) {
          uncertain = false;
          throw Error("Response lost after submission");
        }
        return Response.json({ id: "run_child", status: "queued" });
      }
      if (path === "/v1/runs/run_child/events")
        return new Response('data: {"type":"status","status":"idle"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      if (path === "/v1/runs/run_child" || path === "/v1/runs/run_parent")
        return Response.json({ state: "succeeded" });
      throw Error("Unexpected request " + path);
    }) as typeof fetch;
    const options = {
      settings: normalizeSettings({
        cloudMode: "remote",
        cloudBaseUrl: "http://control.example",
        cloudToken: "fixture",
        llmApiKey: "",
      }),
      signal: new AbortController().signal,
      emit: () => {},
      fetchImpl,
    };
    const failed = await runRemoteCloudAgent({ ...options, session });
    expect(failed.remoteFollowUpPending).toBe(true);
    expect(failed.remoteRunId).toBe("run_parent");
    expect(failed.status).toBe("error");
    const recovered = await runRemoteCloudAgent({
      ...options,
      session: failed,
    });
    expect(keys).toEqual(["ses_follow:user_next", "ses_follow:user_next"]);
    expect(recovered.remoteRunId).toBe("run_child");
    expect(recovered.remoteFollowUpPending).toBeUndefined();
    expect(recovered.status).toBe("idle");
  });
});
