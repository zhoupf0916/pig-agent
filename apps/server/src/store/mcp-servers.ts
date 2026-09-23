import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpDefinitions, parseMcpToolName, type McpServerView, type McpToolView } from "@pig-agent/contracts";
import { DATA_DIR, ensureDir } from "../config.ts";
import { atomicWriteJson, newId } from "../util.ts";
import { callMcpTool, listMcpTools } from "../agent/mcp-client.ts";
import { parseMcpUrl } from "../agent/mcp-egress.ts";
import { desktopSecrets, updateDesktopSecrets } from "./desktop-secrets.ts";

type StoredServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  credentialVersion: number;
  secretDigest?: string;
};

export type McpTarget = { url: string; credentialVersion: number };

const secretDigest = (secret: string | undefined) => secret ? createHash("sha256").update(secret).digest("hex") : undefined;
const file = join(DATA_DIR, "mcp-servers.json");
let queue: Promise<unknown> = Promise.resolve();

function view(server: StoredServer, secretConfigured: boolean): McpServerView {
  return { id: server.id, name: server.name, url: server.url, enabled: server.enabled, timeoutMs: server.timeoutMs, secretConfigured };
}

async function readServers(): Promise<StoredServer[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as StoredServer[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("MCP 配置无法读取");
  }
}

function changeServers(change: (items: StoredServer[]) => StoredServer[] | Promise<StoredServer[]>): Promise<StoredServer[]> {
  const task = queue.then(async () => {
    const next = await change(await readServers());
    ensureDir(DATA_DIR);
    await atomicWriteJson(file, next);
    return next;
  });
  queue = task.catch(() => undefined);
  return task;
}

async function secrets(): Promise<Record<string, string>> {
  if (!desktopSecrets) return {};
  return (await desktopSecrets.read()).mcpSecrets ?? {};
}

async function writeSecret(id: string, secret: string | undefined): Promise<void> {
  await updateDesktopSecrets((current) => {
    const next = { ...(current.mcpSecrets ?? {}) };
    if (secret) next[id] = secret;
    else delete next[id];
    return { llmApiKey: current.llmApiKey, cloudToken: current.cloudToken, codexApiKey: current.codexApiKey || "", mcpSecrets: next };
  });
}

function cleanUrl(raw: string): string {
  const url = parseMcpUrl(raw, true);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function listMcpServers(): Promise<McpServerView[]> {
  const stored = await secrets();
  return (await readServers()).map((server) => view(server, Boolean(stored[server.id])));
}

export async function createMcpServer(input: { name: string; url: string; enabled?: boolean; timeoutMs?: number; secret?: string }): Promise<McpServerView[]> {
  if (input.secret && !desktopSecrets) throw new Error("当前环境不能安全保存 MCP 凭据");
  const url = cleanUrl(input.url);
  const id = newId("m");
  if (input.secret) await writeSecret(id, input.secret);
  try {
    await changeServers((items) => [...items, {
      id, name: input.name.trim(), url, enabled: input.enabled === true, timeoutMs: input.timeoutMs ?? 15_000, credentialVersion: input.secret ? 1 : 0, secretDigest: secretDigest(input.secret),
    }]);
    return listMcpServers();
  } catch (error) {
    if (input.secret) await writeSecret(id, undefined).catch(() => undefined);
    throw error;
  }
}

export async function updateMcpServer(id: string, patch: { name?: string; url?: string; enabled?: boolean; timeoutMs?: number; secret?: string; clearSecret?: boolean }): Promise<McpServerView[]> {
  if (!(await serverRecord(id))) throw new Error("MCP 服务不存在");
  if ((patch.secret || patch.clearSecret) && !desktopSecrets) throw new Error("当前环境不能安全保存 MCP 凭据");
  const url = patch.url === undefined ? undefined : cleanUrl(patch.url);
  if (patch.secret) await writeSecret(id, patch.secret);
  if (patch.clearSecret) await writeSecret(id, undefined);
  await changeServers((items) => {
    if (!items.some((item) => item.id === id)) throw new Error("MCP 服务不存在");
    return items.map((item) => item.id === id ? {
      ...item,
      name: patch.name?.trim() || item.name,
      url: url ?? item.url,
      enabled: patch.enabled ?? item.enabled,
      timeoutMs: patch.timeoutMs ?? item.timeoutMs,
      credentialVersion: item.credentialVersion + 1,
      secretDigest: patch.clearSecret ? undefined : patch.secret ? secretDigest(patch.secret) : item.secretDigest,
    } : item);
  });
  return listMcpServers();
}

export async function deleteMcpServer(id: string): Promise<McpServerView[]> {
  if (desktopSecrets) await writeSecret(id, undefined).catch(() => undefined);
  await changeServers((items) => items.filter((item) => item.id !== id));
  return listMcpServers();
}

async function serverRecord(id: string): Promise<StoredServer | undefined> {
  return (await readServers()).find((item) => item.id === id);
}

export async function requireMcpTarget(tool: string): Promise<McpTarget> {
  const parsed = parseMcpToolName(tool);
  if (!parsed) throw new Error("MCP 工具名无效");
  const server = await serverRecord(parsed.serverId);
  if (!server?.enabled) throw new Error("外部 MCP 未启用或已删除，本次未调用");
  return { url: server.url, credentialVersion: server.credentialVersion };
}

function checkedSecret(server: StoredServer, stored: Record<string,string>): string | undefined {
  const secret = stored[server.id];
  if (secretDigest(secret) !== server.secretDigest) throw new Error("MCP 凭据与配置版本不一致，请重新保存连接；旧审批未执行");
  return secret;
}
async function secretFor(server: StoredServer): Promise<string | undefined> {
  return checkedSecret(server, await secrets());
}

export async function testMcpServer(id: string, signal?: AbortSignal): Promise<McpToolView[]> {
  const server = await serverRecord(id);
  if (!server) throw new Error("MCP 服务不存在");
  return listMcpTools({ id: server.id, name: server.name, url: server.url, timeoutMs: server.timeoutMs, secret: await secretFor(server) }, { allowLoopback: true }, signal);
}

export async function invokeApprovedMcp(tool: string, args: Record<string, unknown>, target: McpTarget | undefined, signal?: AbortSignal): Promise<string> {
  const parsed = parseMcpToolName(tool);
  if (!parsed || !target) throw new Error("外部 MCP 审批缺少目标，未调用");
  const server = await serverRecord(parsed.serverId);
  if (!server?.enabled || server.url !== target.url || server.credentialVersion !== target.credentialVersion) {
    throw new Error("MCP 配置已变化或已停用，旧审批不能执行");
  }
  return callMcpTool({ id: server.id, name: server.name, url: server.url, timeoutMs: server.timeoutMs, secret: await secretFor(server) }, parsed.tool, args, { allowLoopback: true }, signal);
}

export async function prepareSessionMcp(signal: AbortSignal): Promise<{ definitions: ReturnType<typeof mcpDefinitions>; invoke: (call: { name: string; args: Record<string, unknown>; signal: AbortSignal; callId: string }) => Promise<string> }> {
  const stored = await readServers();
  const known = await secrets();
  const targets = new Map<string, McpTarget>();
  const views: McpToolView[] = [];
  for (const server of stored.filter((item) => item.enabled)) {
    targets.set(server.id, { url: server.url, credentialVersion: server.credentialVersion });
    try {
      views.push(...await listMcpTools({ id: server.id, name: server.name, url: server.url, timeoutMs: server.timeoutMs, secret: checkedSecret(server, known) }, { allowLoopback: true }, signal));
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP 连接失败";
      views.push({ serverId: server.id, serverName: server.name, name: "", modelName: null, description: "", inputSchema: null, readOnlyHint: null, skipReason: message.slice(0, 300) });
    }
  }
  return {
    definitions: mcpDefinitions(views),
    invoke: (call) => invokeApprovedMcp(call.name, call.args, targets.get(parseMcpToolName(call.name)?.serverId || ""), call.signal),
  };
}
