import { describe, expect, it } from "vitest";
import { LlmError } from "./openai.ts";
import {
  LOCAL_TURN_MESSAGES,
  decideLocalRetry,
  formatLocalTurnError,
  hasRetryableUserGoal,
  inferLocalErrorCode,
  redactLocalErrorDetail,
  rewindToLastUserGoal,
} from "./local-errors.ts";
import type { Session } from "../types.ts";

function session(messages: Session["messages"]): Session {
  return {
    id: "ses_m",
    title: "m",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages,
    steps: [{ id: "s1", title: "查看目录", status: "error" }],
    artifacts: [],
  };
}

describe("local pig turn errors", () => {
  it("maps bad key / unreachable / tool failures to Chinese", () => {
    expect(formatLocalTurnError(new LlmError("LLM HTTP 401: invalid api key", 401))).toBe(
      LOCAL_TURN_MESSAGES.bad_key,
    );
    expect(inferLocalErrorCode(new LlmError("nope", 403))).toBe("bad_key");
    expect(formatLocalTurnError(new LlmError("Cannot reach LLM at http://127.0.0.1:9/v1/chat/completions. (fetch failed)"))).toBe(
      LOCAL_TURN_MESSAGES.gateway_unreachable,
    );
    expect(formatLocalTurnError(new Error("Sandbox blocked this call: path escape"))).toBe(
      LOCAL_TURN_MESSAGES.tool_failed,
    );
    expect(formatLocalTurnError(new LlmError("LLM HTTP 500: upstream", 500))).toMatch(/LLM 网关返回错误/);
    expect(formatLocalTurnError(new LlmError("rate limited", 429))).toBe(LOCAL_TURN_MESSAGES.rate_limited);
  });

  it("redacts secrets from details", () => {
    const text = formatLocalTurnError(
      new LlmError("LLM HTTP 502: leaked sk-abcdefghijklmnop and Bearer tok-secret", 502),
    );
    expect(text).toMatch(/LLM 网关返回错误/);
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("tok-secret");
    expect(redactLocalErrorDetail("fail DEEPSEEK_API_KEY=sk-abcdefghijklmnop")).not.toMatch(
      /sk-abcdefghijklmnop/,
    );
  });

  it("decides turn vs unavailable and rewinds to the last user goal", () => {
    const empty = session([]);
    expect(hasRetryableUserGoal(empty)).toBe(false);
    expect(decideLocalRetry(empty)).toBe("unavailable");

    const full = session([
      { id: "u1", role: "user", content: "整理工作区", createdAt: new Date().toISOString() },
      { id: "a1", role: "assistant", content: "", createdAt: new Date().toISOString() },
      { id: "t1", role: "tool", content: "fail", createdAt: new Date().toISOString() },
      {
        id: "h1",
        role: "user",
        content: "[harness] A tool failed. Read the error.",
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(decideLocalRetry(full)).toBe("turn");
    rewindToLastUserGoal(full);
    expect(full.messages).toHaveLength(1);
    expect(full.messages[0]?.content).toBe("整理工作区");
    expect(full.steps).toEqual([]);
  });
});
