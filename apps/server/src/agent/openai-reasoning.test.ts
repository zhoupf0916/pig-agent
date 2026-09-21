import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, toOpenAiMessages } from "./openai.ts";
import type { ChatMessage } from "../types.ts";
const settings = { llmBaseUrl: "https://api.deepseek.com", llmApiKey: "test", llmModel: "deepseek-flash" };
afterEach(() => vi.restoreAllMocks());
describe("thinking-mode tool history", () => {
  it("retains streamed reasoning and usage without rendering reasoning as answer text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('data: {"choices":[{"delta":{"reasoning_content":"internal context"}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":6}}\n\ndata: [DONE]\n\n'));
    const onDelta = vi.fn(), onUsage = vi.fn();
    const result = await complete(settings, [], { onDelta, onUsage });
    expect(result.reasoningContent).toBe("internal context"); expect(onDelta).toHaveBeenCalledExactlyOnceWith("answer"); expect(onUsage).toHaveBeenCalledWith({prompt_tokens:12,completion_tokens:6});
    const message: ChatMessage = { id:"msg",role:"assistant",content:result.content,reasoningContent:result.reasoningContent,createdAt:"now",toolCalls:[{id:"call",name:"read_file",arguments:"{}"}] };
    expect(toOpenAiMessages([message])[0]).toHaveProperty("reasoning_content","internal context");
  });
  it("resumes legacy DeepSeek tool history in non-thinking mode", async () => {
    const fetch = vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    await complete(settings,[{id:"old",role:"assistant",content:"",createdAt:"now",toolCalls:[{id:"call",name:"read_file",arguments:"{}"}]}]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).thinking).toEqual({type:"disabled"});
  });
});
