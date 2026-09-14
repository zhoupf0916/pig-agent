import { describe, expect, it } from "vitest";
import {
  CODEX_DEEPSEEK_BASE_URL,
  DEEPSEEK_BASE_URL,
  resolveCloudBaseUrl,
  resolveCloudMode,
  resolveCloudRepoRef,
  resolveCloudRepoUrl,
  resolveCloudToken,
  resolveCodexApiKey,
  resolveCodexBaseUrl,
  resolveLlmApiKey,
} from "./config.ts";

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

describe("Codex env isolation", () => {
  it("reads DEEPSEEK_API_KEY / CODEX_API_KEY only (not LLM_API_KEY)", () => {
    expect(
      resolveCodexApiKey({
        LLM_API_KEY: "llm",
        DEEPSEEK_API_KEY: "ds",
        CODEX_API_KEY: "cx",
      } as NodeJS.ProcessEnv),
    ).toBe("ds");
    expect(resolveCodexApiKey({ CODEX_API_KEY: "cx" } as NodeJS.ProcessEnv)).toBe("cx");
    expect(resolveCodexApiKey({ LLM_API_KEY: "llm" } as NodeJS.ProcessEnv)).toBe("");
  });

  it("does not derive Codex provider URL from the pig Chat Completions /v1 base", () => {
    const env = {
      LLM_BASE_URL: DEEPSEEK_BASE_URL,
    } as NodeJS.ProcessEnv;
    expect(resolveCodexBaseUrl(env)).toBe(CODEX_DEEPSEEK_BASE_URL);
    expect(resolveCodexBaseUrl(env)).not.toContain("/v1");
    expect(resolveCodexBaseUrl({ CODEX_BASE_URL: "https://example.com" } as NodeJS.ProcessEnv)).toBe(
      "https://example.com/",
    );
  });
});

describe("Cloud env isolation", () => {
  it("defaults to local-stub and reads PIG_CLOUD_* without requiring a cluster", () => {
    expect(resolveCloudMode({} as NodeJS.ProcessEnv)).toBe("local-stub");
    expect(resolveCloudMode({ PIG_CLOUD_MODE: "remote" } as NodeJS.ProcessEnv)).toBe("remote");
    expect(resolveCloudBaseUrl({ PIG_CLOUD_BASE_URL: "http://127.0.0.1:8080" } as NodeJS.ProcessEnv)).toBe(
      "http://127.0.0.1:8080",
    );
    expect(resolveCloudToken({ CLOUD_TOKEN: "tok" } as NodeJS.ProcessEnv)).toBe("tok");
    expect(resolveCloudToken({} as NodeJS.ProcessEnv)).toBe("");
    expect(resolveCloudRepoUrl({ PIG_CLOUD_REPO_URL: "https://example.com/app.git" } as NodeJS.ProcessEnv)).toBe(
      "https://example.com/app.git",
    );
    expect(resolveCloudRepoRef({ PIG_CLOUD_REPO_REF: "main" } as NodeJS.ProcessEnv)).toBe("main");
  });
});
