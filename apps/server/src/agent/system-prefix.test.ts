import { describe, expect, it } from "vitest";
import { buildSystemPrompt, SYSTEM_DYNAMIC_MARKER } from "./runtime.ts";
import type { Settings } from "../types.ts";

const settings = { workspaceRoot: "/tmp/ws", llmModel: "m", llmBaseUrl: "http://x" } as Settings;
describe("cache-friendly system prompt", () => {
  it("keeps the static prefix identical regardless of per-turn memory/skills", async () => {
    const a = await buildSystemPrompt(settings, { memoryPins: ["偏好A"] });
    const b = await buildSystemPrompt(settings, { memoryPins: ["偏好B"], projectInstruction: "项目规则", suggested: [] });
    const [pa, da] = a.split(SYSTEM_DYNAMIC_MARKER);
    const [pb, db] = b.split(SYSTEM_DYNAMIC_MARKER);
    expect(pa).toBe(pb);
    expect(da).toContain("偏好A");
    expect(db).toContain("项目规则");
    expect(pa).not.toContain("偏好");
  });
});

import { suggestedSkillsNote } from "./runtime.ts";
describe("per-turn skill suggestions", () => {
  it("are rendered as an ephemeral harness note, not part of the system prompt", async () => {
    const note = suggestedSkillsNote([{ name: "csv", description: "数据", reasons: ["csv"] } as never]);
    expect(note).toContain("csv: 数据");
    const sys = await buildSystemPrompt(settings, { suggested: [] });
    expect(sys).not.toContain("csv: 数据");
  });
});
