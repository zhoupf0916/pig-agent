import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { assertSafeNativeWorkspace, seccompFilter } from "./native-sandbox.ts";
function evaluate(arch: "arm64" | "x64", syscall: number, flags = 0) {
  const filter = seccompFilter(arch);
  let a = 0;
  for (let i = 0; i < filter.length / 8; i++) {
    const code = filter.readUInt16LE(i * 8),
      jt = filter[i * 8 + 2]!,
      jf = filter[i * 8 + 3]!,
      k = filter.readUInt32LE(i * 8 + 4);
    if (code === 0x20)
      a =
        k === 0
          ? syscall
          : k === 4
            ? arch === "arm64"
              ? 0xc00000b7
              : 0xc000003e
            : flags;
    else if (code === 0x15) i += a === k ? jt : jf;
    else if (code === 0x45) i += (a & k) !== 0 ? jt : jf;
    else if (code === 0x06) return k;
    else throw Error("Unknown BPF instruction");
  }
  throw Error("No result");
}
describe("native sandbox policy boundaries", () => {
  it("rejects broad roots even when canonicalized", () => {
    for (const root of ["/", homedir(), tmpdir(), "/usr"])
      expect(() => assertSafeNativeWorkspace(realpathSync(root))).toThrow(
        "项目目录",
      );
    expect(() =>
      assertSafeNativeWorkspace("/home/alice/project"),
    ).not.toThrow();
  });
  for (const arch of ["arm64", "x64"] as const) {
    it(`${arch} denies nested namespaces without breaking ordinary clone`, () => {
      const clone = arch === "arm64" ? 220 : 56;
      expect(evaluate(arch, clone, 17)).toBe(0x7fff0000);
      for (const flag of [
        0x80, 0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000,
        0x40000000,
      ])
        expect(evaluate(arch, clone, flag | 17)).toBe(0x50001);
      expect(evaluate(arch, 435)).toBe(0x50026);
      for (const call of [
        425, 426, 427, 428, 429, 430, 431, 432, 433, 442, 443,
      ])
        expect(evaluate(arch, call)).toBe(0x50001);
      expect(evaluate(arch, arch === "arm64" ? 64 : 1)).toBe(0x7fff0000);
    });
  }
});
