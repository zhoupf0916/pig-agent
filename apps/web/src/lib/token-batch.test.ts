import { describe, expect, it } from "vitest";
import { createTokenBatch } from "./token-batch";

describe("token batches", () => {
  it("applies several deltas in one flush instead of one update per delta", () => {
    const frames: Array<() => void> = [];
    const applied: string[] = [];
    const batch = createTokenBatch(
      (text) => applied.push(text),
      (run) => {
        frames.push(run);
        return frames.length;
      },
      () => {},
    );
    batch.push("你");
    batch.push("好");
    expect(applied).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(applied).toEqual(["你好"]);
  });
});
