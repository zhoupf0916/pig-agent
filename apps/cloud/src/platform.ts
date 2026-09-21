import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import { db, hash } from "./db.ts";
import type { CloudEnv } from "./types.ts";

function masterKey() {
  const key = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error("Missing encryption key");
  return Buffer.from(key, "hex");
}
export function encryptSecret(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decryptSecret(value: string) {
  const [iv, tag, data] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", masterKey(), iv!);
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString("utf8");
}
const channelSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "需要 HTTPS 模型地址"),
    model: z.string().trim().min(1).max(100),
    apiKey: z.string().trim().min(8).max(1000),
  })
  .strict();
const id = () => randomUUID().replaceAll("-", "");
export function registerPlatformRoutes(app: Hono<CloudEnv>) {
  app.post("/auth/accept-invite", async (c) => {
    const body = z
      .object({ invite: z.string().min(32).max(100) })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "邀请无效" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const invite = (
        await client.query(
          "DELETE FROM invitations WHERE token_hash=$1 AND expires_at>now() RETURNING *",
          [hash(body.data.invite)],
        )
      ).rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        return c.json({ error: "邀请已失效或已使用" }, 401);
      }
      const account = "user_" + id(),
        token = randomBytes(32).toString("hex");
      await client.query(
        "INSERT INTO principals(id,name,role,token_hash) VALUES($1,$2,'member',$3)",
        [account, invite.name, hash(randomBytes(32).toString("hex"))],
      );
      await client.query(
        "INSERT INTO auth_sessions(id,owner_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
        [id(), account, hash(token)],
      );
      await client.query(
        "INSERT INTO audit(actor,action) VALUES($1,'accept-invitation')",
        [account],
      );
      await client.query("COMMIT");
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          token,
          expiresInDays: 30,
          account: { id: account, name: invite.name },
        },
        201,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/v1/logout", async (c) => {
    await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
      hash(c.req.header("Authorization")?.replace(/^Bearer /, "") || ""),
    ]);
    return c.json({ ok: true });
  });
  app.get("/v1/usage", async (c) =>
    c.json(
      (
        await db.query(
          "SELECT daily_call_limit,(SELECT count(*) FROM model_usage WHERE owner_id=p.id AND created_at>=date_trunc('day',now())) AS calls_today FROM principals p WHERE id=$1",
          [c.get("principal").id],
        )
      ).rows[0],
    ),
  );
  app.use("/v1/admin/*", async (c, next) => {
    if (c.get("principal").role !== "admin")
      return c.json({ error: "需要管理员权限" }, 403);
    await next();
  });
  app.get("/v1/admin/accounts", async (c) =>
    c.json({
      accounts: (
        await db.query(
          "SELECT id,name,role,enabled,daily_call_limit,(SELECT count(*) FROM model_usage WHERE owner_id=p.id AND created_at>=date_trunc('day',now())) AS calls_today FROM principals p ORDER BY id",
        )
      ).rows,
    }),
  );
  app.post("/v1/admin/invitations", async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "请输入账号名称" }, 400);
    const invite = randomBytes(32).toString("hex");
    await db.query(
      "INSERT INTO invitations(token_hash,name,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [hash(invite), body.data.name],
    );
    await db.query(
      "INSERT INTO audit(actor,action) VALUES($1,'create-invitation')",
      [c.get("principal").id],
    );
    c.header("Cache-Control", "no-store");
    return c.json({ invite, expiresInHours: 24 }, 201);
  });
  app.patch("/v1/admin/accounts/:id", async (c) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        dailyCallLimit: z.number().int().min(0).max(100000).optional(),
        revokeSessions: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "账号设置无效" }, 400);
    if (
      c.req.param("id") === c.get("principal").id &&
      body.data.enabled === false
    )
      return c.json({ error: "不能禁用当前管理员" }, 409);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        "UPDATE principals SET enabled=coalesce($2,enabled),daily_call_limit=coalesce($3,daily_call_limit) WHERE id=$1 RETURNING id",
        [
          c.req.param("id"),
          body.data.enabled ?? null,
          body.data.dailyCallLimit ?? null,
        ],
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "账号不存在" }, 404);
      }
      if (body.data.revokeSessions || body.data.enabled === false)
        await client.query("DELETE FROM auth_sessions WHERE owner_id=$1", [
          c.req.param("id"),
        ]);
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        c.get("principal").id,
        "account-policy:" + c.req.param("id"),
      ]);
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/v1/admin/channels", async (c) =>
    c.json({
      channels: (
        await db.query(
          "SELECT id,name,base_url,model,enabled,created_at FROM model_channels ORDER BY created_at DESC",
        )
      ).rows,
    }),
  );
  app.post("/v1/admin/channels", async (c) => {
    const body = channelSchema.safeParse(await c.req.json());
    if (!body.success)
      return c.json({ error: "渠道参数无效，请使用 HTTPS 地址" }, 400);
    const channelId = "channel_" + id();
    await db.query(
      "INSERT INTO model_channels(id,name,base_url,model,secret) VALUES($1,$2,$3,$4,$5)",
      [
        channelId,
        body.data.name,
        body.data.baseUrl.replace(/\/$/, ""),
        body.data.model,
        encryptSecret(body.data.apiKey),
      ],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      c.get("principal").id,
      "create-channel:" + channelId,
    ]);
    return c.json({ id: channelId }, 201);
  });
  app.delete("/v1/admin/channels/:id", async (c) => {
    const result = await db.query(
      "DELETE FROM model_channels WHERE id=$1 AND NOT enabled RETURNING id",
      [c.req.param("id")],
    );
    if (!result.rowCount)
      return c.json({ error: "渠道不存在或仍处于启用状态" }, 409);
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      c.get("principal").id,
      "delete-channel:" + c.req.param("id"),
    ]);
    return c.json({ ok: true });
  });
  app.post("/v1/admin/channels/:id/activate", async (c) => {
    const body = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "渠道设置无效" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71839022)");
      if (
        !(
          await client.query("SELECT id FROM model_channels WHERE id=$1", [
            c.req.param("id"),
          ])
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "渠道不存在" }, 404);
      }
      if (body.data.enabled)
        await client.query(
          "UPDATE model_channels SET enabled=false WHERE enabled",
        );
      await client.query("UPDATE model_channels SET enabled=$2 WHERE id=$1", [
        c.req.param("id"),
        body.data.enabled,
      ]);
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        c.get("principal").id,
        "channel-policy:" + c.req.param("id"),
      ]);
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/v1/admin/channels/:id/test", async (c) => {
    const channel = (
      await db.query("SELECT * FROM model_channels WHERE id=$1", [
        c.req.param("id"),
      ])
    ).rows[0];
    if (!channel) return c.json({ error: "渠道不存在" }, 404);
    try {
      const r = await fetch(channel.base_url + "/chat/completions", {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${decryptSecret(channel.secret)}`,
        },
        body: JSON.stringify({
          model: channel.model,
          messages: [{ role: "user", content: "Reply OK" }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      return c.json({ ok: r.ok, status: r.status });
    } catch {
      return c.json({ ok: false, error: "无法连接模型渠道" }, 502);
    }
  });
}
