import { describe, expect, it } from "vitest";
import { CloudRuntimeError } from "./contract.ts";
import {
  CLOUD_REMOTE_MESSAGES,
  cloudRemoteError,
  formatCloudRemoteError,
  isCloudTimeoutError,
  isUserAbort,
} from "./errors.ts";

describe("cloud remote Chinese errors", () => {
  it("maps missing URL / snapshot / timeout to readable Chinese", () => {
    expect(cloudRemoteError("missing_url").message).toBe(CLOUD_REMOTE_MESSAGES.missing_url);
    expect(cloudRemoteError("snapshot_failed", "工作区路径不是可读目录").message).toBe(
      "工作区快照失败：工作区路径不是可读目录",
    );
    expect(cloudRemoteError("control_plane_timeout").message).toBe(
      CLOUD_REMOTE_MESSAGES.control_plane_timeout,
    );
    expect(formatCloudRemoteError(new Error("Cloud base URL is required in remote mode"))).toBe(
      CLOUD_REMOTE_MESSAGES.missing_url,
    );
    expect(formatCloudRemoteError(new Error("Snapshot path escape refused"))).toMatch(/工作区快照失败/);
    expect(formatCloudRemoteError(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe(
      CLOUD_REMOTE_MESSAGES.control_plane_timeout,
    );
    expect(formatCloudRemoteError(new CloudRuntimeError("已是中文", "generic"))).toBe("已是中文");
  });

  it("does not treat a user abort as a control-plane timeout", () => {
    const user = new AbortController();
    user.abort();
    expect(isUserAbort(new Error("Aborted"), user.signal)).toBe(true);
    expect(isCloudTimeoutError(new Error("Aborted"), user.signal)).toBe(false);
  });
});
