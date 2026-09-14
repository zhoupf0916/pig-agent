import { describe, expect, it } from "vitest";
import { isMorePage } from "./MoreMenu";

describe("isMorePage", () => {
  it("puts only memory and automations in the More overflow", () => {
    expect(isMorePage("memory")).toBe(true);
    expect(isMorePage("automations")).toBe(true);
    expect(isMorePage("projects")).toBe(false);
    expect(isMorePage("experts")).toBe(false);
    expect(isMorePage("workstation")).toBe(false);
    expect(isMorePage("search")).toBe(false);
  });
});
