import { describe, expect, it } from "vitest";
import type { Session } from "../../types.ts";
import { CodexTrustError } from "./home.ts";
import {
  CODEX_TURN_MESSAGES,
  CodexSessionError,
  CodexValidationError,
  decideCodexRetry,
  formatCodexTurnError,
  inferCodexErrorCode,
  redactCodexErrorDetail,
} from "./errors.ts";

function session(messages: Session["messages"]): Session {
  return {
    id: "ses_n",
    title: "n",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages,
    steps: [],
    artifacts: [],
  };
}

describe("Codex turn errors", () => {
  it("maps missing binary / bad config / start / session failures to Chinese", () => {
    expect(formatCodexTurnError(new CodexValidationError("binary_missing", "/no/such/codex"))).toMatch(
      /未找到 Codex 二进制/,
    );
    expect(inferCodexErrorCode(new CodexValidationError("home_unwritable"))).toBe("home_unwritable");
    expect(formatCodexTurnError(new CodexValidationError("api_key_missing"))).toBe(
      CODEX_TURN_MESSAGES.api_key_missing,
    );
    expect(formatCodexTurnError(new CodexTrustError("Workspace root does not exist: /tmp/x"))).toBe(
      CODEX_TURN_MESSAGES.workspace_invalid,
    );
    expect(formatCodexTurnError(new Error("spawn /opt/codex EACCES"))).toMatch(/进程启动失败/);
    expect(formatCodexTurnError(new CodexSessionError("turn.failed boom"))).toMatch(/本轮执行失败/);
    expect(formatCodexTurnError(new Error("No user/assistant text to send to Codex"))).toBe(
      CODEX_TURN_MESSAGES.empty_prompt,
    );
  });

  it("redacts secrets from details", () => {
    const text = formatCodexTurnError(
      new CodexSessionError("provider 401 leaked sk-abcdefghijklmnop and Bearer tok-secret"),
    );
    expect(text).toMatch(/本轮执行失败/);
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("tok-secret");
    expect(redactCodexErrorDetail("fail CODEX_API_KEY=sk-abcdefghijklmnop")).not.toMatch(
      /sk-abcdefghijklmnop/,
    );
  });

  it("reuses local turn vs unavailable for 重试本轮", () => {
    expect(decideCodexRetry(session([]))).toBe("unavailable");
    expect(
      decideCodexRetry(
        session([
          { id: "u1", role: "user", content: "写一个文件", createdAt: new Date().toISOString() },
        ]),
      ),
    ).toBe("turn");
  });
});
