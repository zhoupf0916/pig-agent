import { describe, expect, it } from "vitest";
import { applyReplacements, applyUnifiedPatch, PatchError } from "./patch.ts";

describe("applyReplacements", () => {
  it("applies unique sequential replacements", () => {
    const next = applyReplacements("alpha beta gamma", [
      { old_string: "beta", new_string: "BETA" },
      { old_string: "gamma", new_string: "G" },
    ]);
    expect(next).toBe("alpha BETA G");
  });

  it("rejects non-unique old_string", () => {
    expect(() =>
      applyReplacements("x x", [{ old_string: "x", new_string: "y" }]),
    ).toThrow(PatchError);
  });
});

describe("applyUnifiedPatch", () => {
  it("applies a unified hunk", () => {
    const original = ["line1", "old", "line3"].join("\n");
    const patch = [
      "--- a/file",
      "+++ b/file",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old",
      "+new",
      " line3",
      "",
    ].join("\n");
    expect(applyUnifiedPatch(original, patch)).toBe(["line1", "new", "line3"].join("\n"));
  });

  it("accepts a Begin Patch wrapper", () => {
    const original = "hello world";
    const patch = ["*** Begin Patch", "@@", "-hello world", "+hello pig", "*** End Patch"].join(
      "\n",
    );
    expect(applyUnifiedPatch(original, patch)).toBe("hello pig");
  });
});
