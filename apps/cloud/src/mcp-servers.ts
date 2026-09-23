import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Hono } from "hono";
import {
  mcpDefinitions,
  parseMcpToolName,
  type McpServerView,
} from "@pig-agent/contracts";
import { db, hash } from "./db.ts";
import { decryptSecret, encryptSecret } from "./platform.ts";
import {
  assertCloudMcpUrl,
  callRemoteTool,
  listRemoteTools,
} from "./mcp-http.ts";
import type { CloudEnv } from "./types.ts";

const id = () => "m_" + randomBytes(8).toString("hex");
const fields = {
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(120_000),
  secret: z.string().max(4000),
  clearSecret: z.boolean(),
};

function present(row: {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  timeout_ms: number;
  secret: string | null;
}): McpServerView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    timeoutMs: row.timeout_ms,
    secretConfigured: Boolean(row.secret),
  };
}

/** Cancellation and lease revocation must reach the external HTTP request on any control instance. */
function watchMcpRun(token: string, requestSignal: AbortSignal) {
  const cancelled = new AbortController();
  let checking = false;
  const timer = setInterval(() => {
    if (checking || cancelled.signal.aborted) return;
    checking = true;
    void db
      .query(
        "SELECT id FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true))",
        [hash(token)],
      )
      .then((result) => {
        if (!result.rows.length) cancelled.abort();
      })
      .catch(() => cancelled.abort())
      .finally(() => {
        checking = false;
      });
  }, 500);
  timer.unref();
  return {
    signal: AbortSignal.any([requestSignal, cancelled.signal]),
    stop: () => clearInterval(timer),
  };
}

export function registerMcpRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/mcp/servers", async (c) => {
    const rows = (
      await db.query(
        "SELECT id,name,url,enabled,timeout_ms,secret FROM mcp_servers WHERE owner_id=$1 ORDER BY created_at,id",
        [c.get("principal").id],
      )
    ).rows;
    return c.json({ servers: rows.map(present) });
  });
  app.post("/v1/mcp/servers", async (c) => {
    const parsed = z
      .object({
        name: fields.name,
        url: fields.url,
        enabled: fields.enabled.optional(),
        timeoutMs: fields.timeoutMs.optional(),
        secret: fields.secret.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "请填写 MCP 名称、地址和超时" }, 400);
    try {
      assertCloudMcpUrl(parsed.data.url, c.get("principal").role);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "MCP 地址被拒绝" },
        400,
      );
    }
    const serverId = id();
    const secret = parsed.data.secret
      ? encryptSecret(parsed.data.secret)
      : null;
    await db.query(
      "INSERT INTO mcp_servers(id,owner_id,name,url,enabled,timeout_ms,secret,credential_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        serverId,
        c.get("principal").id,
        parsed.data.name,
        assertCloudMcpUrl(parsed.data.url, c.get("principal").role).toString(),
        parsed.data.enabled === true,
        parsed.data.timeoutMs ?? 15_000,
        secret,
        secret ? 1 : 0,
      ],
    );
    const rows = (
      await db.query(
        "SELECT id,name,url,enabled,timeout_ms,secret FROM mcp_servers WHERE owner_id=$1 ORDER BY created_at,id",
        [c.get("principal").id],
      )
    ).rows;
    return c.json({ servers: rows.map(present) }, 201);
  });
  app.patch("/v1/mcp/servers/:id", async (c) => {
    const parsed = z
      .object({
        name: fields.name.optional(),
        url: fields.url.optional(),
        enabled: fields.enabled.optional(),
        timeoutMs: fields.timeoutMs.optional(),
        secret: fields.secret.optional(),
        clearSecret: fields.clearSecret.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "MCP 修改无效" }, 400);
    const owner = c.get("principal").id;
    const current = (
      await db.query(
        "SELECT id,url FROM mcp_servers WHERE id=$1 AND owner_id=$2",
        [c.req.param("id"), owner],
      )
    ).rows[0];
    if (!current) return c.json({ error: "MCP 服务不存在" }, 404);
    let url: string | null = null;
    if (parsed.data.url) {
      try {
        url = assertCloudMcpUrl(
          parsed.data.url,
          c.get("principal").role,
        ).toString();
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "MCP 地址被拒绝" },
          400,
        );
      }
    }
    const secret = parsed.data.secret
      ? encryptSecret(parsed.data.secret)
      : null;
    await db.query(
      "UPDATE mcp_servers SET name=COALESCE($3,name),url=COALESCE($4,url),enabled=COALESCE($5,enabled),timeout_ms=COALESCE($6,timeout_ms),secret=CASE WHEN $7::text IS NOT NULL THEN $7 WHEN $8 THEN NULL ELSE secret END,credential_version=credential_version+1,updated_at=now() WHERE id=$1 AND owner_id=$2",
      [
        c.req.param("id"),
        owner,
        parsed.data.name ?? null,
        url,
        parsed.data.enabled ?? null,
        parsed.data.timeoutMs ?? null,
        secret,
        parsed.data.clearSecret === true,
      ],
    );
    const rows = (
      await db.query(
        "SELECT id,name,url,enabled,timeout_ms,secret FROM mcp_servers WHERE owner_id=$1 ORDER BY created_at,id",
        [owner],
      )
    ).rows;
    return c.json({ servers: rows.map(present) });
  });
  app.delete("/v1/mcp/servers/:id", async (c) => {
    await db.query("DELETE FROM mcp_servers WHERE id=$1 AND owner_id=$2", [
      c.req.param("id"),
      c.get("principal").id,
    ]);
    const rows = (
      await db.query(
        "SELECT id,name,url,enabled,timeout_ms,secret FROM mcp_servers WHERE owner_id=$1 ORDER BY created_at,id",
        [c.get("principal").id],
      )
    ).rows;
    return c.json({ servers: rows.map(present) });
  });
  app.post("/v1/mcp/servers/:id/test", async (c) => {
    const row = (
      await db.query(
        "SELECT id,name,url,timeout_ms,secret FROM mcp_servers WHERE id=$1 AND owner_id=$2",
        [c.req.param("id"), c.get("principal").id],
      )
    ).rows[0];
    if (!row) return c.json({ error: "MCP 服务不存在" }, 404);
    try {
      const tools = await listRemoteTools(
        {
          id: row.id,
          name: row.name,
          url: row.url,
          timeoutMs: row.timeout_ms,
          secret: row.secret ? decryptSecret(row.secret) : undefined,
          role: c.get("principal").role,
        },
        c.req.raw.signal,
      );
      return c.json({ tools });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "MCP 连接失败" },
        400,
      );
    }
  });

  app.post("/internal/mcp/tools", async (c) => {
    const body = z
      .object({ token: z.string().min(1).max(200) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "无效令牌" }, 400);
    const run = (
      await db.query(
        "SELECT id,owner_id,input FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now()",
        [hash(body.data.token)],
      )
    ).rows[0];
    if (!run) return c.json({ error: "运行已失效" }, 401);
    if (run.input?.networkPolicy === "blocked")
      return c.json({ tools: [], targets: [], notice: "任务已禁止网络访问" });
    const owner = (
      await db.query("SELECT role,enabled FROM principals WHERE id=$1", [
        run.owner_id,
      ])
    ).rows[0];
    if (!owner?.enabled)
      return c.json({ error: "账号已停用，未连接 MCP" }, 403);
    if (run.input?.projectId) {
      const project = (
        await db.query("SELECT space_id FROM projects WHERE id=$1", [
          run.input.projectId,
        ])
      ).rows[0];
      if (!project || project.space_id)
        return c.json({
          tools: [],
          targets: [],
          notice: "项目协同任务不加载私人 MCP 连接",
        });
    }
    const rows = (
      await db.query(
        "SELECT id,name,url,timeout_ms,secret,credential_version FROM mcp_servers WHERE owner_id=$1 AND enabled",
        [run.owner_id],
      )
    ).rows;
    const tools = [];
    const targets = [];
    const monitor = watchMcpRun(body.data.token, c.req.raw.signal);
    try {
      for (const row of rows) {
        targets.push({
          serverId: row.id,
          url: row.url,
          credentialVersion: row.credential_version,
        });
        try {
          tools.push(
            ...(await listRemoteTools(
              {
                id: row.id,
                name: row.name,
                url: row.url,
                timeoutMs: row.timeout_ms,
                secret: row.secret ? decryptSecret(row.secret) : undefined,
                role: owner?.role || "member",
              },
              monitor.signal,
            )),
          );
        } catch (error) {
          tools.push({
            serverId: row.id,
            serverName: row.name,
            name: "",
            modelName: null,
            description: "",
            inputSchema: null,
            readOnlyHint: null,
            skipReason:
              error instanceof Error
                ? error.message.slice(0, 300)
                : "MCP 连接失败",
          });
        }
      }
      return c.json({ tools: mcpDefinitions(tools), targets });
    } finally {
      monitor.stop();
    }
  });

  app.post("/internal/mcp/invoke", async (c) => {
    const body = z
      .object({
        token: z.string().min(1).max(200),
        callId: z.string().min(1).max(200),
        tool: z.string().min(1).max(80),
        args: z.record(z.unknown()),
        url: z.string().min(1).max(500),
        credentialVersion: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "MCP 调用参数无效" }, 400);
    const parsed = parseMcpToolName(body.data.tool);
    if (!parsed) return c.json({ error: "MCP 工具名无效" }, 400);
    const client = await db.connect();
    let server:
      | {
          id: string;
          name: string;
          url: string;
          timeout_ms: number;
          secret: string | null;
          role: string;
        }
      | undefined;
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          "SELECT id,owner_id,input FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now() FOR UPDATE",
          [hash(body.data.token)],
        )
      ).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return c.json({ error: "运行已失效，未调用 MCP" }, 401);
      }
      if (run.input?.networkPolicy === "blocked") {
        await client.query("ROLLBACK");
        return c.json({ error: "任务已禁止网络访问，未调用 MCP" }, 403);
      }
      const owner = (
        await client.query("SELECT role,enabled FROM principals WHERE id=$1", [
          run.owner_id,
        ])
      ).rows[0];
      if (!owner?.enabled) {
        await client.query("ROLLBACK");
        return c.json({ error: "账号已停用，未调用 MCP" }, 403);
      }
      if (run.input?.projectId) {
        const project = (
          await client.query("SELECT space_id FROM projects WHERE id=$1", [
            run.input.projectId,
          ])
        ).rows[0];
        if (!project || project.space_id) {
          await client.query("ROLLBACK");
          return c.json({ error: "项目协同任务不能使用私人 MCP 连接" }, 403);
        }
      }
      const approval = (
        await client.query(
          "SELECT id,state,args,mcp_target FROM approvals WHERE run_id=$1 AND call_id=$2 AND tool=$3 FOR UPDATE",
          [run.id, body.data.callId, body.data.tool],
        )
      ).rows[0];
      if (
        !approval ||
        approval.state !== "consumed" ||
        !isDeepStrictEqual(approval.args, body.data.args) ||
        approval.mcp_target?.url !== body.data.url ||
        approval.mcp_target?.credentialVersion !==
          body.data.credentialVersion ||
        approval.mcp_target?.serverId !== parsed.serverId
      ) {
        await client.query("ROLLBACK");
        return c.json(
          { error: "MCP 审批不存在、未通过或输入不匹配，未调用" },
          403,
        );
      }
      const inserted = await client.query(
        "INSERT INTO mcp_invocations(approval_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING approval_id",
        [approval.id],
      );
      if (!inserted.rows[0]) {
        await client.query("ROLLBACK");
        return c.json({ error: "该 MCP 调用已经执行，不会自动重试" }, 409);
      }
      const row = (
        await client.query(
          "SELECT s.id,s.name,s.url,s.timeout_ms,s.secret,p.role FROM mcp_servers s JOIN principals p ON p.id=s.owner_id WHERE s.id=$1 AND s.owner_id=$2 AND s.enabled AND s.url=$3 AND s.credential_version=$4",
          [
            parsed.serverId,
            run.owner_id,
            body.data.url,
            body.data.credentialVersion,
          ],
        )
      ).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return c.json({ error: "MCP 配置已变化或已停用，旧审批不能执行" }, 409);
      }
      server = row;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!server)
      return c.json({ error: "MCP 配置已变化或已停用，旧审批不能执行" }, 409);
    const monitor = watchMcpRun(body.data.token, c.req.raw.signal);
    try {
      const output = await callRemoteTool(
        {
          id: server.id,
          name: server.name,
          url: server.url,
          timeoutMs: server.timeout_ms,
          secret: server.secret ? decryptSecret(server.secret) : undefined,
          role: server.role,
        },
        parsed.tool,
        body.data.args,
        monitor.signal,
      );
      return c.json({ output });
    } catch (error) {
      return c.json(
        {
          error: monitor.signal.aborted
            ? "任务已取消或授权失效，已停止 MCP 连接。外部已产生的效果不能自动撤销。"
            : error instanceof Error
              ? error.message
              : "MCP 调用失败",
        },
        502,
      );
    } finally {
      monitor.stop();
    }
  });
}
