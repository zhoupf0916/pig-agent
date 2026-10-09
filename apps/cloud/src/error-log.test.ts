import { describe, expect, it } from "vitest";
import { requestErrorLine } from "./error-log.ts";

describe("requestErrorLine", () => {
  it("labels node-postgres errors with their SQLSTATE and the route pattern", () => {
    const pg = Object.assign(new Error('relation "x" does not exist'), { name: "error", code: "42P01" });
    expect(requestErrorLine(pg, "POST", "/internal/mcp/tools")).toBe("Request failed: DatabaseError code=42P01 POST /internal/mcp/tools");
  });
  it("never includes the message or unexpected code values", () => {
    const err = Object.assign(new TypeError("secret-token-value"), { code: "has spaces and secret" });
    const line = requestErrorLine(err, "GET", "/v1/runs/:id");
    expect(line).toBe("Request failed: TypeError GET /v1/runs/:id");
    expect(line).not.toContain("secret");
  });
  it("handles thrown non-errors", () => {
    expect(requestErrorLine("boom", "GET", "/")).toBe("Request failed: string GET /");
  });
});
