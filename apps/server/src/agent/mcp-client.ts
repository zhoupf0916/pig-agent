import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exposedMcpToolName, mcpDefinitions, mcpToolName, parseMcpToolName, redactConfiguredSecret, redactSecretValue, type McpToolView } from "@pig-agent/contracts";
import { createPinnedMcpFetch, type McpEgressOptions } from "./mcp-egress.ts";

const SDK_VERSION = "1.30.0";
const MAX_SCHEMA_CHARS = 8_000;
export const MCP_SDK = { version: SDK_VERSION, transport: "streamable-http" } as const;
export { mcpDefinitions };

function publicMcpError(error: unknown, secret: string | undefined): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactConfiguredSecret(message, secret) || "MCP 调用失败");
}

type ServerConfig = { id: string; name: string; url: string; timeoutMs: number; secret?: string };

function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const bounded = AbortSignal.timeout(Math.min(120_000, Math.max(500, timeoutMs || 15_000)));
  return signal ? AbortSignal.any([signal, bounded]) : bounded;
}

export async function withMcpClient<T>(config: ServerConfig, options: McpEgressOptions, run: (client: Client, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const timed = deadline(config.timeoutMs, signal);
  const fetch = createPinnedMcpFetch({ ...options, deadline: timed });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requestInit: {
      headers: config.secret ? { authorization: `Bearer ${config.secret}` } : {},
    },
  });
  const client = new Client({ name: "pig-agent", version: "0.3.0" }, { capabilities: {} });
  const stop = () => { void transport.close().catch(() => undefined); };
  timed.addEventListener("abort", stop, { once: true });
  try {
    await client.connect(transport);
    return await run(client, timed);
  } catch (error) {
    throw publicMcpError(error, config.secret);
  } finally {
    timed.removeEventListener("abort", stop);
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

function boundedSchema(schema: unknown): { schema: Record<string, unknown> } | { skip: string } {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { skip: "缺少 inputSchema" };
  const text = JSON.stringify(schema);
  if (text.length > MAX_SCHEMA_CHARS) return { skip: "inputSchema 超过上限" };
  return { schema: schema as Record<string, unknown> };
}

export async function listMcpTools(config: ServerConfig, options: McpEgressOptions, signal?: AbortSignal): Promise<McpToolView[]> {
  return withMcpClient(config, options, async (client) => {
    const listed = await client.listTools();
    return listed.tools.slice(0, 40).map((tool) => {
      const remoteName = tool.name;
      const modelName = exposedMcpToolName(config.id, remoteName);
      const schema = boundedSchema(redactSecretValue(tool.inputSchema, config.secret));
      const nameLeaks = Boolean(config.secret && remoteName.includes(config.secret));
      const skipReason = nameLeaks
        ? "工具名包含已配置凭据，未挂载"
        : !modelName
          ? "工具名不符合模型命名或长度限制，未挂载，避免调用错名"
          : "skip" in schema
            ? schema.skip
            : null;
      return {
        serverId: config.id,
        serverName: redactConfiguredSecret(config.name, config.secret),
        name: nameLeaks ? "" : remoteName,
        modelName: nameLeaks ? null : modelName,
        description: redactConfiguredSecret(tool.description ?? "", config.secret).slice(0, 400),
        inputSchema: "schema" in schema ? schema.schema : null,
        readOnlyHint: typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : null,
        skipReason,
      };
    });
  }, signal);
}

export async function callMcpTool(config: ServerConfig, tool: string, args: Record<string, unknown>, options: McpEgressOptions, signal?: AbortSignal): Promise<string> {
  const parsed = parseMcpToolName(mcpToolName(config.id, tool));
  if (!parsed) throw new Error("MCP 工具名无效");
  return withMcpClient(config, options, async (client, timed) => {
    const result = await client.callTool({ name: parsed.tool, arguments: args }, undefined, { signal: timed });
    const text = redactConfiguredSecret(JSON.stringify(result), config.secret).slice(0, 8000);
    return text.length === 8000 ? `${text}…[truncated]` : text;
  }, signal);
}
