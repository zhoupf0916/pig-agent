export const MCP_TOOL_PREFIX = "mcp__";

export type EcosystemSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Optional pack files. Contents are materialized, not inlined into the prompt. */
  files?: import("./skill-pack.js").SkillPackFile[];
};

export type EcosystemExpert = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  skillIds: string[];
};

export type EcosystemPlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  purpose: string;
  skills: EcosystemSkill[];
  experts: EcosystemExpert[];
};

export type McpServerView = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  secretConfigured: boolean;
};

/** Snapshot used to invalidate approval after a connection is edited. */
export type McpExecutionTarget = { url: string; credentialVersion: number };

export type McpToolView = {
  serverId: string;
  serverName: string;
  /** Exact tool name on the MCP server. Never a truncated alias. */
  name: string;
  /** Model-facing name. Null when it cannot be expressed without changing the remote name. */
  modelName: string | null;
  description: string;
  inputSchema: Record<string, unknown> | null;
  readOnlyHint: boolean | null;
  skipReason: string | null;
};

const MODEL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Provider-safe name, or null when using it would require changing the remote tool name. */
export function exposedMcpToolName(serverId: string, remoteName: string): string | null {
  const exposed = mcpToolName(serverId, remoteName);
  if (!MODEL_TOOL_NAME.test(exposed)) return null;
  if (parseMcpToolName(exposed)?.tool !== remoteName) return null;
  return exposed;
}

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${tool}`;
}

const REDACTED = "[redacted]";

/** Exact replacement of one configured credential. An empty secret does not change the text. */
export function redactConfiguredSecret(value: string, secret: string | undefined): string {
  if (!secret || !value.includes(secret)) return value;
  return value.split(secret).join(REDACTED);
}

/** Redacts values; reject credential-bearing keys rather than silently changing tool parameters. */
export function redactSecretValue(value: unknown, secret: string | undefined): unknown {
  if (!secret) return value;
  if (typeof value === "string") return redactConfiguredSecret(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item, secret));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.includes(secret)) throw new Error("MCP 参数名包含凭据，未挂载此服务的工具");
    out[key] = redactSecretValue(item, secret);
  }
  return out;
}

export function mcpDefinitions(tools: McpToolView[]) {
  return tools.flatMap((tool) => tool.modelName && tool.inputSchema ? [{
    type: "function" as const,
    function: {
      name: tool.modelName,
      description: `外部 MCP「${tool.serverName}」的 ${tool.name}。实际在该 MCP 服务执行，不在本机 Seatbelt 或 Bubblewrap 内。每次调用都要审批。${tool.description}`,
      parameters: tool.inputSchema,
    },
  }] : []);
}

export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  return { serverId: rest.slice(0, split), tool: rest.slice(split + 2) };
}
