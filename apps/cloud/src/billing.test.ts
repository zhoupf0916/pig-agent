import { describe, it, expect } from "vitest";
import { priceUsage, reserveCost, parseUsage } from "./billing.js";
describe("人民币模型额度", () => {
  it("按输入、缓存与输出 tokens 计算微元，不能用调用次数代替金额", () => {
    expect(
      priceUsage(
        { input: 1000000, cached: 200000, output: 100000 },
        { input: 2, cached: 0.04, output: 8 },
      ),
    ).toBe(2408000);
  });
  it("缺失和负数用量不能被当成免费调用", () => {
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ prompt_tokens: -1, completion_tokens: 5 })).toBeNull();
  });
  it("预留预算覆盖完整输入和最大输出而不依赖客户端价格", () => {
    expect(
      reserveCost({ messages: [{ content: "test" }] }, 4096, {
        input: 2,
        cached: 0.04,
        output: 8,
      }),
    ).toBeGreaterThanOrEqual(32768);
  });
  it("兼容 DeepSeek 缓存用量并把命中数限制在输入范围内", () => {
    expect(
      parseUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 30,
      }),
    ).toEqual({ input: 10, output: 2, cached: 10 });
  });
});
