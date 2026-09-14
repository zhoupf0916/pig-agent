import { describe, expect, it } from "vitest";
import type { AgentEvent, PlanStep, Session } from "../../types.ts";
import { DEFAULT_SETTINGS } from "../../config.ts";
import {
  CREATE_RUN_PROGRESS,
  CreateRunProgress,
  isCreateRunProgressStep,
  sanitizeCreateRunProgressCopy,
} from "./create-run-progress.ts";

function session(): Session {
  return {
    id: "ses_w",
    title: "w",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    messages: [],
    steps: [],
    artifacts: [],
  };
}

describe("create-run progress copy", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("uses readable Chinese titles and never embeds secret-shaped text", () => {
    const dumped = JSON.stringify(CREATE_RUN_PROGRESS);
    expect(dumped).toMatch(/[\u4e00-\u9fff]/);
    expect(CREATE_RUN_PROGRESS.snapshot.title).toMatch(/快照/);
    expect(CREATE_RUN_PROGRESS.create.title).toMatch(/创建/);
    expect(CREATE_RUN_PROGRESS.subscribe.title).toMatch(/事件流/);
    expect(dumped).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(dumped).not.toMatch(/Bearer\s+\S+/);
    expect(dumped).not.toContain("DEEPSEEK_API_KEY");
    expect(dumped).not.toContain("PIG_CLOUD_TOKEN");
    expect(sanitizeCreateRunProgressCopy("失败 sk-abcdefghijklmnop Bearer tok-secret")).not.toMatch(
      /sk-abcdefghijklmnop|tok-secret/,
    );
  });

  it("emits steps through the existing channel and hands off to streaming", () => {
    const ses = session();
    const events: AgentEvent[] = [];
    const progress = new CreateRunProgress(ses, (e) => events.push(e));
    progress.begin("snapshot");
    progress.begin("create");
    expect(ses.steps.map((s) => s.id)).toEqual(["create-run:snapshot", "create-run:post"]);
    expect(ses.steps[0]?.status).toBe("done");
    expect(ses.steps[1]?.status).toBe("running");
    expect(ses.steps[1]?.title).toBe("创建远程运行");
    expect(events.every((e) => e.type === "steps")).toBe(true);

    progress.fail();
    expect(ses.steps.find((s) => s.id === "create-run:post")?.status).toBe("error");
    expect(ses.status).toBe("running"); // fail() does not own session.status

    progress.handoffToStream();
    expect(ses.steps).toEqual([]);
    expect(ses.steps.some(isCreateRunProgressStep)).toBe(false);
  });

  it("abort clears running chips so idle is not a visual zombie", () => {
    const ses = session();
    const keep: PlanStep = { id: "plan_1", title: "写报告", status: "pending" };
    ses.steps = [keep];
    const progress = new CreateRunProgress(ses, () => undefined);
    progress.begin("subscribe");
    progress.abort();
    expect(ses.steps).toEqual([keep]);
  });
});
