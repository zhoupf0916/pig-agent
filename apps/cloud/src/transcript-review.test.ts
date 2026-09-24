import { expect, it } from "vitest";
import { attachRunOutcomes } from "./transcript.ts";

it("does not assign an earlier failed run to a later message with the same prompt text", () => {
  const createdAt = "2026-09-24T00:00:00.000Z";
  const messages = [
    { id: "prompt:run_first", role: "user" as const, content: "继续", createdAt },
    { id: "legacy_followup_user", role: "user" as const, content: "继续", createdAt },
  ];
  const runs = [
    { id: "run_first", prompt: "继续", state: "failed", error: "第一次执行失败", input: { prompt: "继续", messages: [] } },
    { id: "run_second", prompt: "继续", state: "succeeded", input: { prompt: "继续", messages } },
  ];
  const shown = attachRunOutcomes(messages, runs);
  expect(shown[0]?.outcome).toBe("failed");
  expect(shown[1]?.outcome).not.toBe("failed");
  expect(shown[1]?.notice).not.toBe("第一次执行失败");
});
