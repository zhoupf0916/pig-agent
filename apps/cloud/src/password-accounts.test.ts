import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  usernameSchema,
  passwordSchema,
  registrationAction,
  loginFailure,
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
  it("lets a rejected applicant try again and keeps pending or active accounts", () => {
    expect(registrationAction(false, null)).toBe("create");
    expect(registrationAction(false, "rejected")).toBe("reapply");
    expect(registrationAction(false, "pending")).toBe("pending");
    expect(registrationAction(false, "approved")).toBe("taken");
    expect(registrationAction(true, "rejected")).toBe("taken");
  });
  it("tells the applicant whether review is still open", () => {
    expect(loginFailure("pending")).toMatchObject({
      status: 403,
      error: "申请正在审核，通过后即可登录",
    });
    expect(loginFailure("rejected").error).toContain("重新提交");
    expect(loginFailure("disabled").status).toBe(403);
    expect(loginFailure("invalid")).toEqual({
      status: 401,
      error: "账号或密码不正确",
    });
  });
});
