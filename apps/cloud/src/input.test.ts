import { describe, expect, it } from "vitest";
import { inputSchema } from "./input.ts";

describe("run input debug content", () => {
  it("does not collect debug bodies unless the request explicitly enables them", () => {
    const prompt = { prompt: "回复一句" };
    expect(inputSchema.parse(prompt).debugContent).toBeUndefined();
    expect(inputSchema.parse({ ...prompt, debugContent: false }).debugContent).toBe(false);
    expect(inputSchema.parse({ ...prompt, debugContent: true }).debugContent).toBe(true);
  });
});
