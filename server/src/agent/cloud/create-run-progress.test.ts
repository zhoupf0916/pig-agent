import { describe, expect, it } from "vitest";
import type { AgentEvent, PlanStep, Session } from "../../types.ts";
import { DEFAULT_SETTINGS } from "../../config.ts";
import {
  CREATE_RUN_PROGRESS,
  CreateRunProgress,
  FOLLOW_UP_PROGRESS,
  isCreateRunProgressStep,
  isFollowUpProgressStep,
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

describe("follow-up / reconnect progress copy", () => {
  it("uses distinct Chinese titles from create-run and never embeds secrets", () => {
    const dumped = JSON.stringify(FOLLOW_UP_PROGRESS);
    expect(dumped).toMatch(/[\u4e00-\u9fff]/);
    expect(FOLLOW_UP_PROGRESS.followup.title).toMatch(/跟进/);
    expect(FOLLOW_UP_PROGRESS.reconnect.title).toMatch(/事件流/);
    expect(FOLLOW_UP_PROGRESS.followup.title).not.toBe(CREATE_RUN_PROGRESS.create.title);
    expect(FOLLOW_UP_PROGRESS.reconnect.title).not.toBe(CREATE_RUN_PROGRESS.subscribe.title);
    expect(dumped).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(dumped).not.toMatch(/Bearer\s+\S+/);
    expect(dumped).not.toContain("DEEPSEEK_API_KEY");
    expect(dumped).not.toContain("PIG_CLOUD_TOKEN");
  });

  it("emits follow-up steps then hands off without create-run chips", () => {
    const ses = session();
    const events: AgentEvent[] = [];
    const progress = new CreateRunProgress(ses, (e) => events.push(e));
    progress.begin("followup");
    progress.begin("reconnect");
    expect(ses.steps.map((s) => s.id)).toEqual(["follow-up:post", "follow-up:subscribe"]);
    expect(ses.steps[0]?.status).toBe("done");
    expect(ses.steps[1]?.status).toBe("running");
    expect(ses.steps[1]?.title).toBe("重新连接事件流");
    expect(ses.steps.some(isCreateRunProgressStep)).toBe(false);
    expect(events.every((e) => e.type === "steps")).toBe(true);

    progress.fail();
    expect(ses.steps.find((s) => s.id === "follow-up:subscribe")?.status).toBe("error");
    expect(ses.status).toBe("running");

    progress.handoffToStream();
    expect(ses.steps).toEqual([]);
    expect(ses.steps.some(isFollowUpProgressStep)).toBe(false);
  });

  it("drops follow-up chips when falling back to create-run (no mixed catalogs)", () => {
    const ses = session();
    const progress = new CreateRunProgress(ses, () => undefined);
    progress.begin("followup");
    expect(ses.steps.map((s) => s.id)).toEqual(["follow-up:post"]);
    progress.begin("snapshot");
    expect(ses.steps.map((s) => s.id)).toEqual(["create-run:snapshot"]);
    expect(ses.steps.some(isFollowUpProgressStep)).toBe(false);
    progress.begin("create");
    expect(ses.steps.some(isFollowUpProgressStep)).toBe(false);
    expect(ses.steps.map((s) => s.id)).toEqual(["create-run:snapshot", "create-run:post"]);
  });
});
