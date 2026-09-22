import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  usernameSchema,
  passwordSchema,
} from "./password-accounts.ts";
describe("password credentials", () => {
  it("uses random salts, rejects wrong and malformed password hashes", async () => {
    const a = await hashPassword("strong-test-password"),
      b = await hashPassword("strong-test-password");
    expect(a).not.toBe(b);
    expect(a).not.toContain("strong-test-password");
    expect(await verifyPassword("strong-test-password", a)).toBe(true);
    expect(await verifyPassword("wrong-password", a)).toBe(false);
    expect(
      await verifyPassword("strong-test-password", "scrypt$999999999$8$1$x$y"),
    ).toBe(false);
  });
  it("normalizes account names and rejects unsafe names or weak-length passwords", () => {
    expect(usernameSchema.parse(" Alice.Test ")).toBe("alice.test");
    for (const name of ["ab", "../root", "a b", "用户", "a".repeat(33)])
      expect(usernameSchema.safeParse(name).success).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });
});
