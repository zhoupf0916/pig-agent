import { describe, expect, it } from "vitest";
import { resolveLlmApiKey } from "./config.ts";

describe("resolveLlmApiKey", () => {
  it("prefers LLM_API_KEY, then DEEPSEEK, then OPENAI", () => {
    expect(
      resolveLlmApiKey({
        LLM_API_KEY: "llm",
        DEEPSEEK_API_KEY: "ds",
        OPENAI_API_KEY: "oa",
      } as NodeJS.ProcessEnv),
    ).toBe("llm");
    expect(
      resolveLlmApiKey({
        DEEPSEEK_API_KEY: "ds",
        OPENAI_API_KEY: "oa",
      } as NodeJS.ProcessEnv),
    ).toBe("ds");
    expect(resolveLlmApiKey({ OPENAI_API_KEY: "oa" } as NodeJS.ProcessEnv)).toBe("oa");
    expect(resolveLlmApiKey({} as NodeJS.ProcessEnv)).toBe("");
  });
});
