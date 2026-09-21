import { afterEach, describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "./platform.ts";
const before = process.env.ENCRYPTION_KEY;
afterEach(() => {
  if (before === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = before;
});
describe("model channel credentials", () => {
  it("encrypts with randomized nonces and authenticates ciphertext", () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const a = encryptSecret("fixture-secret"),
      b = encryptSecret("fixture-secret");
    expect(a).not.toEqual(b);
    expect(a).not.toContain("fixture-secret");
    expect(decryptSecret(a)).toBe("fixture-secret");
    const parts = a.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptSecret(a)).toThrow();
  });
  it("refuses missing key instead of storing plaintext", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("secret")).toThrow("Missing encryption key");
  });
});
