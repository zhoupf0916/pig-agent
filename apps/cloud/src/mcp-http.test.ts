import { afterEach, describe, expect, it } from "vitest";
import { assertCloudMcpUrl, assertResolvedAddresses, McpEgressError } from "./mcp-http.ts";

afterEach(() => { delete process.env.MCP_ENDPOINT_ALLOWLIST; });

describe("cloud MCP network boundary", () => {
  it("rejects multicast, broadcast, metadata and private addresses for ordinary tenants", () => {
    for (const target of ["http://224.0.0.1/mcp", "http://255.255.255.255/mcp", "http://169.254.169.254/mcp", "http://127.0.0.1:9/mcp", "http://10.0.0.8/mcp"]) {
      expect(() => assertCloudMcpUrl(target, "member")).toThrow(McpEgressError);
    }
    expect(() => assertResolvedAddresses(["64:ff9b::a9fe:a9fe"], "public")).toThrow(McpEgressError);
    expect(() => assertCloudMcpUrl("https://8.8.8.8/mcp", "member")).not.toThrow();
  });

  it("lets an admin allow one exact fixture endpoint without opening metadata or the rest of the private network", () => {
    process.env.MCP_ENDPOINT_ALLOWLIST = "http://10.1.2.3:8080/mcp";
    expect(() => assertCloudMcpUrl("http://10.1.2.3:8080/mcp", "admin")).not.toThrow();
    expect(() => assertCloudMcpUrl("http://10.1.2.3:8080/mcp", "member")).toThrow(McpEgressError);
    expect(() => assertCloudMcpUrl("http://10.9.9.9/mcp", "admin")).toThrow(McpEgressError);
    process.env.MCP_ENDPOINT_ALLOWLIST = "http://169.254.169.254/mcp";
    expect(() => assertCloudMcpUrl("http://169.254.169.254/mcp", "admin")).toThrow(McpEgressError);
    expect(() => assertResolvedAddresses(["64:ff9b::a9fe:a9fe"], "allowlisted")).toThrow(McpEgressError);
  });
});
