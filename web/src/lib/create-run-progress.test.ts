import { describe, expect, it } from "vitest";
import {
  isCodexProgressStep,
  isCreateRunProgressStep,
  isFollowUpProgressStep,
  isLocalStubProgressStep,
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

describe("local-stub materialize progress UI labels", () => {
  it("shows the running Chinese local-stub chip instead of 正在思考…", () => {
    expect(
      streamingStatusLabel([
        { id: "local-stub:materialize", title: "准备隔离工作区", status: "running" },
      ]),
    ).toBe("准备隔离工作区");
    expect(
      streamingStatusLabel([{ id: "local-stub:start", title: "启动本机循环", status: "running" }]),
    ).toBe("启动本机循环");
  });

  it("does not treat local-stub ids as W/X chips", () => {
    expect(
      isLocalStubProgressStep({ id: "local-stub:materialize", title: "准备隔离工作区", status: "running" }),
    ).toBe(true);
    expect(
      isCreateRunProgressStep({ id: "local-stub:materialize", title: "准备隔离工作区", status: "running" }),
    ).toBe(false);
    expect(
      isFollowUpProgressStep({ id: "local-stub:start", title: "启动本机循环", status: "running" }),
    ).toBe(false);
    expect(isLocalStubProgressStep({ id: "create-run:snapshot", title: "准备沙箱快照", status: "done" })).toBe(
      false,
    );
    expect(isLocalStubProgressStep({ id: "follow-up:post", title: "继续跟进", status: "running" })).toBe(
      false,
    );
  });
});

describe("Codex startup progress UI labels", () => {
  it("shows the running Chinese Codex chip instead of 正在思考…", () => {
    expect(
      streamingStatusLabel([{ id: "codex:env", title: "准备 Codex 环境", status: "running" }]),
    ).toBe("准备 Codex 环境");
    expect(
      streamingStatusLabel([{ id: "codex:spawn", title: "启动 Codex 进程", status: "running" }]),
    ).toBe("启动 Codex 进程");
  });

  it("does not treat Codex ids as W/X/AD chips", () => {
    expect(isCodexProgressStep({ id: "codex:env", title: "准备 Codex 环境", status: "running" })).toBe(
      true,
    );
    expect(
      isCreateRunProgressStep({ id: "codex:env", title: "准备 Codex 环境", status: "running" }),
    ).toBe(false);
    expect(
      isFollowUpProgressStep({ id: "codex:spawn", title: "启动 Codex 进程", status: "running" }),
    ).toBe(false);
    expect(
      isLocalStubProgressStep({ id: "codex:spawn", title: "启动 Codex 进程", status: "running" }),
    ).toBe(false);
    expect(isCodexProgressStep({ id: "create-run:snapshot", title: "准备沙箱快照", status: "done" })).toBe(
      false,
    );
    expect(isCodexProgressStep({ id: "follow-up:post", title: "继续跟进", status: "running" })).toBe(
      false,
    );
    expect(
      isCodexProgressStep({ id: "local-stub:materialize", title: "准备隔离工作区", status: "running" }),
    ).toBe(false);
  });
});
