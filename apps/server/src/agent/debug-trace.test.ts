import { describe, expect, it } from "vitest";
import {
  DEBUG_TRACE_LIMITS,
  clearDebugView,
  debugDetail,
  dropDebugSession,
  finishDebugSpan,
  presentDebugTrace,
  redactDebug,
  readDebugTrace,
  recordDebugSpan,
  setDebugContent,
} from "./debug-trace.ts";

describe("debug traces stay on the session that recorded them", () => {
  it("does not return another session's calls or secrets", () => {
    dropDebugSession("ses_a");
    dropDebugSession("ses_b");
    recordDebugSpan({
      id: "span_a",
      sessionId: "ses_a",
      kind: "model",
      name: "chat",
      status: "ok",
      startedAtMs: 1,
      durationMs: 2,
      detail: { authorization: "Bearer sk-supersecretkey", url: "https://api.example/v1?token=abc" },
    });
    recordDebugSpan({
      id: "span_b",
      sessionId: "ses_b",
      kind: "tool",
      name: "run_shell",
      status: "ok",
      startedAtMs: 3,
    });
    const view = readDebugTrace("ses_a");
    expect(view.spans.map((span) => span.id)).toEqual(["span_a"]);
    expect(JSON.stringify(view)).not.toContain("sk-supersecretkey");
    expect(JSON.stringify(view)).not.toContain("token=abc");
    expect(JSON.stringify(view)).toContain("[redacted]");
  });

  it("updates a repeated span id instead of listing the same call twice", () => {
    dropDebugSession("ses_dedupe");
    recordDebugSpan({ id: "span_1", sessionId: "ses_dedupe", kind: "model", name: "chat", status: "running", startedAtMs: 1 });
    recordDebugSpan({ id: "span_1", sessionId: "ses_dedupe", kind: "model", name: "chat", status: "ok", startedAtMs: 1, durationMs: 12 });
    expect(readDebugTrace("ses_dedupe").spans).toHaveLength(1);
    expect(readDebugTrace("ses_dedupe").spans[0]?.status).toBe("ok");
  });

  it("hides model text until the current user turns content on, and clearing the view keeps that choice", () => {
    dropDebugSession("ses_content");
    const hidden = debugDetail("ses_content", { model: "mock" }, { text: "private prompt" });
    expect(hidden).toEqual({ model: "mock", content: "完整内容未开启" });
    setDebugContent("ses_content", true);
    recordDebugSpan({
      id: "span_text",
      sessionId: "ses_content",
      kind: "model",
      name: "chat",
      status: "ok",
      startedAtMs: 1,
      detail: debugDetail("ses_content", { model: "mock" }, { text: "Bearer sk-supersecretkey" }),
    });
    expect(JSON.stringify(readDebugTrace("ses_content"))).not.toContain("sk-supersecretkey");
    expect(JSON.stringify(readDebugTrace("ses_content"))).toContain("Bearer [redacted]");
    clearDebugView("ses_content");
    expect(readDebugTrace("ses_content").spans).toEqual([]);
    expect(readDebugTrace("ses_content").contentEnabled).toBe(true);
  });
});

describe("debug text redacts synthetic credentials before they can be exported", () => {
  it("removes cookie, api key, password and url userinfo from the stored detail and the export", () => {
    const marker = "SYNTHETIC_CANARY_NOT_A_REAL_SECRET";
    dropDebugSession("ses_redact");
    setDebugContent("ses_redact", true);
    const samples = [
      `Cookie: session=${marker}`,
      `X-API-Key: ${marker}`,
      `password=${marker}`,
      `https://user:${marker}@example.invalid/x`,
    ];
    for (const [index, text] of samples.entries()) {
      recordDebugSpan({
        id: `span_secret_${index}`,
        sessionId: "ses_redact",
        kind: "tool",
        name: "read_file",
        status: "error",
        startedAtMs: index,
        detail: debugDetail("ses_redact", {}, { output: text, error: text }),
      });
    }
    const exported = JSON.stringify(readDebugTrace("ses_redact"));
    expect(exported).not.toContain(marker);
    expect(exported).toContain("[redacted]");
  });

  it("redacts env assignments, quoted JSON secrets, and basic authorization from tool output without hiding usage counts", () => {
    const marker = "SYNTHETIC_CANARY_NOT_A_REAL_SECRET";
    dropDebugSession("ses_redact_formats");
    setDebugContent("ses_redact_formats", true);
    const samples = [
      `API_KEY=${marker}`,
      `{"password":"${marker}"}`,
      `Authorization: Basic ${marker}`,
    ];
    for (const [index, text] of samples.entries()) {
      recordDebugSpan({
        id: `span_format_${index}`,
        sessionId: "ses_redact_formats",
        kind: "tool",
        name: "read_file",
        status: "ok",
        startedAtMs: index,
        detail: debugDetail("ses_redact_formats", {
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }, { output: text }),
      });
    }
    const exported = JSON.stringify(readDebugTrace("ses_redact_formats"));
    expect(exported).not.toContain(marker);
    expect(exported).toContain('"prompt_tokens":100');
    expect(exported).toContain('"completion_tokens":10');
    expect(exported).toContain('"total_tokens":110');
  });
});

describe("debug usage stays readable", () => {
  it("redacts a token field without hiding prompt, completion, or total token counts", () => {
    const marker = "SYNTHETIC_CANARY_NOT_A_REAL_SECRET";
    const detail = redactDebug({
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      token: marker,
    }) as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; token: string };
    expect(detail.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    expect(detail.token).toBe("[redacted]");
    expect(JSON.stringify(detail)).not.toContain(marker);
  });
});

describe("remote debug content stays off unless that run allowed it", () => {
  it("omits captured messages and responses when content was not allowed for the run", () => {
    const view = {
      sessionId: "ses_remote",
      contentEnabled: true,
      dropped: 0,
      spans: [{
        id: "model_1",
        sessionId: "ses_remote",
        kind: "model" as const,
        name: "mock",
        status: "ok" as const,
        startedAtMs: 1,
        detail: {
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          finishReason: "stop",
          request: { body: { messages: [{ role: "user", content: "secret prompt" }] } },
          response: "secret answer",
        },
      }],
    };
    const hidden = presentDebugTrace(view, false);
    const hiddenText = JSON.stringify(hidden);
    expect(hiddenText).not.toContain("secret prompt");
    expect(hiddenText).not.toContain("secret answer");
    expect(hidden.contentEnabled).toBe(false);
    expect(hidden.spans[0]?.detail?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    expect(JSON.stringify(presentDebugTrace(view, true))).toContain("secret prompt");
  });
});

describe("debug retention stays within the published limits", () => {
  it("drops the oldest sessions once the trace map exceeds the session cap", () => {
    const extra = 8;
    const total = DEBUG_TRACE_LIMITS.maxSessions + extra;
    for (let i = 0; i < total; i += 1) {
      const sessionId = `cap-${i}`;
      dropDebugSession(sessionId);
      recordDebugSpan({
        id: "span",
        sessionId,
        kind: "tool",
        name: "read_file",
        status: "ok",
        startedAtMs: 1,
        detail: { marker: `M${i}` },
      });
    }
    expect(JSON.stringify(readDebugTrace("cap-0"))).not.toContain("M0");
    expect(JSON.stringify(readDebugTrace(`cap-${extra}`))).toContain(`M${extra}`);
    expect(JSON.stringify(readDebugTrace(`cap-${total - 1}`))).toContain(`M${total - 1}`);
  });

  it("caps one span's stored size and says the byte limit truncated it", () => {
    dropDebugSession("ses_bytes");
    setDebugContent("ses_bytes", true);
    const detail: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) detail[`field${i}`] = "x".repeat(3000);
    recordDebugSpan({
      id: "fat",
      sessionId: "ses_bytes",
      kind: "model",
      name: "chat",
      status: "ok",
      startedAtMs: 1,
      detail,
    });
    const span = readDebugTrace("ses_bytes").spans[0];
    expect(Buffer.byteLength(JSON.stringify(span))).toBeLessThanOrEqual(DEBUG_TRACE_LIMITS.maxSpanBytes);
    expect(span?.truncated).toContain("字节");
  });

  it("does not keep an unbounded object by only shortening strings", () => {
    dropDebugSession("ses_keys");
    const detail: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) detail[`k${i}`] = "v";
    recordDebugSpan({
      id: "wide",
      sessionId: "ses_keys",
      kind: "tool",
      name: "read_file",
      status: "ok",
      startedAtMs: 1,
      detail,
    });
    const span = readDebugTrace("ses_keys").spans[0];
    expect(span?.detail?.k49).toBeUndefined();
    expect(span?.detail?.k0).toBe("v");
    expect(span?.truncated).toContain("字段");
  });

  it("drops older spans when the retained traces exceed the total byte budget", () => {
    dropDebugSession("ses_budget");
    setDebugContent("ses_budget", true);
    for (let i = 0; i < 40; i += 1) {
      const detail: Record<string, string> = {};
      for (let key = 0; key < 20; key += 1) detail[`f${i}_${key}`] = "y".repeat(3000);
      recordDebugSpan({
        id: `fat-${i}`,
        sessionId: "ses_budget",
        kind: "model",
        name: "chat",
        status: "ok",
        startedAtMs: i,
        detail,
      });
    }
    const view = readDebugTrace("ses_budget");
    const bytes = view.spans.reduce((sum, span) => sum + Buffer.byteLength(JSON.stringify(span)), 0);
    expect(bytes).toBeLessThanOrEqual(DEBUG_TRACE_LIMITS.maxTotalBytes);
    expect(view.dropped).toBeGreaterThan(0);
    expect(view.spans.at(-1)?.id).toBe("fat-39");
  });
});

describe("closing a span uses the time until it actually finished", () => {
  it("replaces the staging duration with the time from start through finish", async () => {
    dropDebugSession("ses_finish");
    const started = performance.now();
    recordDebugSpan({
      id: "wait",
      sessionId: "ses_finish",
      kind: "approval",
      name: "write_file",
      status: "running",
      startedAtMs: 0,
      durationMs: 1,
      detail: { output: "待批准，尚未执行。" },
    }, started);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finishDebugSpan("ses_finish", "wait", "ok", { output: "Created proof.txt (4 chars)" })).toBe(true);
    const span = readDebugTrace("ses_finish").spans[0];
    expect(span?.status).toBe("ok");
    expect(span?.durationMs).toBeGreaterThan(50);
    expect(span?.detail?.output).toBe("Created proof.txt (4 chars)");
  });
});

describe("debug HTTP stays on the requested session", () => {
  it("returns 404 for a missing session and does not show another session's trace", async () => {
    const { createApp } = await import("../app.ts");
    const { saveSession } = await import("../store/sessions.ts");
    const app = createApp();
    const missing = await app.request("/api/sessions/ses_missing_debug/debug");
    expect(missing.status).toBe(404);
    const now = new Date().toISOString();
    await saveSession({
      id: "ses_http_debug",
      title: "调试",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages: [],
      steps: [],
      artifacts: [],
    });
    dropDebugSession("ses_http_debug");
    dropDebugSession("ses_other_debug");
    recordDebugSpan({
      id: "span_http",
      sessionId: "ses_http_debug",
      kind: "tool",
      name: "read_file",
      status: "ok",
      startedAtMs: 4,
      detail: { authorization: "Bearer sk-supersecretkey" },
    });
    recordDebugSpan({
      id: "span_other",
      sessionId: "ses_other_debug",
      kind: "model",
      name: "chat",
      status: "ok",
      startedAtMs: 5,
    });
    const body = await (await app.request("/api/sessions/ses_http_debug/debug")).json() as { spans: Array<{ id: string }> };
    expect(body.spans.map((span) => span.id)).toEqual(["span_http"]);
    expect(JSON.stringify(body)).not.toContain("sk-supersecretkey");
    const cleared = await app.request("/api/sessions/ses_http_debug/debug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true, content: true }),
    });
    const after = await cleared.json() as { spans: unknown[]; contentEnabled: boolean };
    expect(after.spans).toEqual([]);
    expect(after.contentEnabled).toBe(true);
  });
});
