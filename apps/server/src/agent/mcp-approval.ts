import { parseMcpToolName } from "@pig-agent/contracts";

/** MCP stays on the approval path even when ordinary tools are allowed to run automatically. */
export function cloudToolGate(tool: string, requireApproval: boolean): "mcp" | "standard" | "auto" {
  if (parseMcpToolName(tool)) return "mcp";
  return requireApproval ? "standard" : "auto";
}
