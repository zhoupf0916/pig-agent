import { describe, expect, it } from "vitest";
import { CloudRuntimeError } from "./contract.ts";
import {
  CLOUD_REMOTE_MESSAGES,
  cloudRemoteError,
  decideRemoteRetry,
  formatCloudRemoteError,
  isCloudTimeoutError,
  isUserAbort,
  redactCloudErrorDetail,
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

  it("maps expired / disconnect and redacts secrets from details", () => {
    expect(formatCloudRemoteError(new Error("run expired"))).toBe(CLOUD_REMOTE_MESSAGES.run_expired);
    expect(formatCloudRemoteError(new Error("ECONNRESET socket hang up"))).toBe(
      CLOUD_REMOTE_MESSAGES.disconnected,
    );
    expect(redactCloudErrorDetail("fail sk-abcdefghijklmnop Bearer tok-secret")).not.toMatch(
      /sk-abcdefghijklmnop|tok-secret/,
    );
    expect(cloudRemoteError("create_run_failed", "（HTTP 500）sk-abcdefghijklmnop").message).not.toContain(
      "sk-abcdefghijklmnop",
    );
    expect(decideRemoteRetry(cloudRemoteError("missing_url"))).toBe("unavailable");
    expect(decideRemoteRetry(cloudRemoteError("run_expired"), "run_old")).toBe("create-run");
    expect(decideRemoteRetry(cloudRemoteError("control_plane_timeout"), "run_live")).toBe("follow-up");
    expect(decideRemoteRetry(cloudRemoteError("disconnected"))).toBe("create-run");
  });
});
