import { describe, expect, it } from "vitest";
import {
  EXPERT_INSTRUCTION_HEADING,
  PROJECT_INSTRUCTION_HEADING,
  formatBoundInstructionBlock,
  prependBoundInstructions,
} from "./bound-instructions.ts";

describe("bound instruction composition", () => {
  it("puts expert before project and documents both headings", () => {
    const block = formatBoundInstructionBlock({
      expertInstruction: "先侦察。",
      projectInstruction: "始终用中文。",
    });
    expect(block.indexOf(EXPERT_INSTRUCTION_HEADING)).toBe(0);
    expect(block.indexOf(EXPERT_INSTRUCTION_HEADING)).toBeLessThan(
      block.indexOf(PROJECT_INSTRUCTION_HEADING),
    );
    expect(block).toContain("先侦察。");
    expect(block).toContain("始终用中文。");
  });

  it("omits empty sides", () => {
    expect(formatBoundInstructionBlock({ projectInstruction: "  " })).toBe("");
    expect(formatBoundInstructionBlock({ expertInstruction: "只探索" })).toContain("只探索");
    expect(formatBoundInstructionBlock({ expertInstruction: "只探索" })).not.toContain(
      PROJECT_INSTRUCTION_HEADING,
    );
  });

  it("prepends the block ahead of the user prompt", () => {
    const text = prependBoundInstructions("写 hello.md", { expertInstruction: "评审，不要改。" });
    expect(text.startsWith(EXPERT_INSTRUCTION_HEADING)).toBe(true);
    expect(text.endsWith("写 hello.md")).toBe(true);
  });
});
