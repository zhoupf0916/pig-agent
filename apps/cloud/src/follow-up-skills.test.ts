import { describe, expect, it } from "vitest";
import { followUpSkillPlan } from "./conversations.ts";

describe("follow-up skill snapshots", () => {
  it("keeps the previous snapshot when skillIds is omitted by the same member", () => {
    expect(followUpSkillPlan({ sameOwner: true })).toBe("reuse");
  });

  it("replaces the snapshot when an array is sent, including an empty clear", () => {
    expect(followUpSkillPlan({ sameOwner: true, explicitSkillIds: ["data-analysis"] })).toBe("replace");
    expect(followUpSkillPlan({ sameOwner: true, explicitSkillIds: [] })).toBe("replace");
  });

  it("does not reuse another member's private snapshot", () => {
    expect(followUpSkillPlan({ sameOwner: false })).toBe("clear");
    expect(followUpSkillPlan({ sameOwner: false, explicitSkillIds: ["data-analysis"] })).toBe("replace");
  });
});
