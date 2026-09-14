import { describe, expect, it } from "vitest";
import {
  isCreateRunProgressStep,
  isFollowUpProgressStep,
  streamingStatusLabel,
} from "./create-run-progress";

describe("create-run progress UI labels", () => {
  it("shows the running Chinese create-run chip instead of 正在思考…", () => {
    expect(
      streamingStatusLabel([
        { id: "create-run:post", title: "创建远程运行", status: "running" },
      ]),
    ).toBe("创建远程运行");
    expect(
      streamingStatusLabel([{ id: "step_plan", title: "写报告", status: "running" }]),
    ).toBe("正在思考…");
    expect(streamingStatusLabel([])).toBe("正在思考…");
  });

  it("only treats create-run: ids as bootstrap chips", () => {
    expect(isCreateRunProgressStep({ id: "create-run:snapshot", title: "准备沙箱快照", status: "done" })).toBe(
      true,
    );
    expect(isCreateRunProgressStep({ id: "s1", title: "写报告", status: "pending" })).toBe(false);
  });
});

describe("follow-up / reconnect progress UI labels", () => {
  it("shows the running Chinese follow-up chip instead of 正在思考…", () => {
    expect(
      streamingStatusLabel([{ id: "follow-up:post", title: "继续跟进", status: "running" }]),
    ).toBe("继续跟进");
    expect(
      streamingStatusLabel([
        { id: "follow-up:subscribe", title: "重新连接事件流", status: "running" },
      ]),
    ).toBe("重新连接事件流");
  });

  it("does not treat follow-up ids as create-run chips", () => {
    expect(isFollowUpProgressStep({ id: "follow-up:post", title: "继续跟进", status: "running" })).toBe(
      true,
    );
    expect(isCreateRunProgressStep({ id: "follow-up:post", title: "继续跟进", status: "running" })).toBe(
      false,
    );
    expect(isFollowUpProgressStep({ id: "create-run:post", title: "创建远程运行", status: "running" })).toBe(
      false,
    );
  });
});
