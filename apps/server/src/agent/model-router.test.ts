import { describe, expect, it } from "vitest";
import { classifyDifficulty, ModelRouter, routerConfigFromEnv } from "./model-router.ts";

describe("model router", () => {
  it("is a no-op unless configured", () => {
    const r = new ModelRouter("deepseek-chat", routerConfigFromEnv({}), "列出文件");
    expect(r.enabled).toBe(false);
    expect(r.current().model).toBe("deepseek-chat");
  });
  it("classifies by difficulty", () => {
    expect(classifyDifficulty("列出工作区的文件").tier).toBe("fast");
    expect(classifyDifficulty("帮我排查这个并发 bug 的根因并给出修复方案").tier).toBe("strong");
    expect(classifyDifficulty("hi", { priorToolErrors: 1 }).tier).toBe("strong");
    expect(classifyDifficulty("x".repeat(700)).tier).toBe("strong");
  });
  it("routes to the tier model and only escalates", () => {
    const r = new ModelRouter("base", { fast: "deepseek-chat", strong: "deepseek-reasoner" }, "读一下 README");
    expect(r.current()).toMatchObject({ model: "deepseek-chat", tier: "fast" });
    r.escalate("本轮工具失败");
    expect(r.current()).toMatchObject({ model: "deepseek-reasoner", tier: "strong", reason: "本轮工具失败" });
    const onlyStrong = new ModelRouter("base", { strong: "big" }, "看看");
    expect(onlyStrong.current().model).toBe("base");
  });
});
