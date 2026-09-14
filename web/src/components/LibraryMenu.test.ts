import { describe, expect, it } from "vitest";
import { isLibraryPage } from "./LibraryMenu";

describe("isLibraryPage", () => {
  it("treats directory surfaces as library, not workstation or search", () => {
    expect(isLibraryPage("projects")).toBe(true);
    expect(isLibraryPage("experts")).toBe(true);
    expect(isLibraryPage("automations")).toBe(true);
    expect(isLibraryPage("memory")).toBe(true);
    expect(isLibraryPage("workstation")).toBe(false);
    expect(isLibraryPage("search")).toBe(false);
  });
});
