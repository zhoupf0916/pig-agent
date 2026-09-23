import { describe, expect, it } from "vitest";
import { cloudToolGate } from "./mcp-approval.ts";

describe("MCP approval gate", () => {
  it("still requires approval for MCP tools when ordinary tools are automatic", () => {
    expect(cloudToolGate("write_file", false)).toBe("auto");
    expect(cloudToolGate("mcp__docs__write_marker", false)).toBe("mcp");
    expect(cloudToolGate("mcp__docs__echo", true)).toBe("mcp");
    expect(cloudToolGate("write_file", true)).toBe("standard");
  });
});
