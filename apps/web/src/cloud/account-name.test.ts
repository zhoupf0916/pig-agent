import { describe, expect, it } from "vitest";
import { accountNamePattern } from "./account-name";

const matcher = new RegExp(`^(?:${accountNamePattern})$`, "v");

describe("account name pattern", () => {
  it("compiles with the HTML pattern unicode-sets flag", () => {
    expect(() => new RegExp(accountNamePattern, "v")).not.toThrow();
  });
  it("accepts a normal account and rejects names that are too short", () => {
    expect(matcher.test("alice.01")).toBe(true);
    expect(matcher.test("ab")).toBe(false);
    expect(matcher.test("a".repeat(33))).toBe(false);
  });
});
