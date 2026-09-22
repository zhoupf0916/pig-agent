import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { db, hash } from "./db.ts";
import type { CloudEnv } from "./types.ts";
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const passwordSchema = z.string().min(10).max(128);
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$16384$8$1$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join("$") !== "scrypt$16384$8$1" ||
    !/^[a-f0-9]{32}$/.test(parts[4]!) ||
    !/^[a-f0-9]{128}$/.test(parts[5]!)
  )
    return false;
  const key = await derive(password, parts[4]!);
  return timingSafeEqual(key, Buffer.from(parts[5]!, "hex"));
}
const dummyHash =
  "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);
export type PasswordLogin =
  | {
      ok: true;
      id: string;
      role: string;
      name: string;
      credentialHash: string;
    }
  | { ok: false; reason: "pending" | "rejected" | "disabled" | "invalid" };
export function loginFailure(
  reason: Exclude<PasswordLogin, { ok: true }>["reason"],
): { status: 401 | 403; error: string } {
  if (reason === "pending")
    return { status: 403, error: "申请正在审核，通过后即可登录" };
  if (reason === "rejected")
    return { status: 403, error: "申请未通过，可以重新提交申请" };
  if (reason === "disabled")
    return { status: 403, error: "账号已停用，请联系管理员" };
  return { status: 401, error: "账号或密码不正确" };
}
/** Existing password accounts and approved requests stay taken. A rejection can be replaced by a new application. */
export function registrationAction(
  hasAccount: boolean,
  state: string | null,
): "taken" | "pending" | "reapply" | "create" {
  if (hasAccount || state === "approved") return "taken";
  if (state === "pending") return "pending";
  if (state === "rejected") return "reapply";
  return "create";
}
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<PasswordLogin> {
  const result = (
    await db.query(
      "SELECT p.id,p.role,p.name,p.enabled,a.password_hash FROM password_accounts a JOIN principals p ON p.id=a.owner_id WHERE a.username=$1",
      [username],
    )
  ).rows[0];
  const valid = await verifyPassword(
    password,
    result?.password_hash || dummyHash,
  );
  if (result && valid)
    return result.enabled
      ? {
          ok: true,
          id: result.id,
          role: result.role,
          name: result.name,
          credentialHash: result.password_hash,
        }
      : { ok: false, reason: "disabled" };
  if (result) return { ok: false, reason: "invalid" };
  const registration = (
    await db.query(
      "SELECT state FROM registration_requests WHERE username=$1",
      [username],
    )
  ).rows[0];
  if (registration?.state === "pending" || registration?.state === "rejected")
    return { ok: false, reason: registration.state };
  return { ok: false, reason: "invalid" };
}
// Shared account bucket supplements the global auth budget and protects expensive password hashes.
export async function allowPasswordAttempt(username: string) {
  const key = "passwordAuth:" + hash(username);
  const r = await db.query(
    `INSERT INTO platform_settings(key,value) VALUES ($1,jsonb_build_object('window',floor(extract(epoch FROM now())/60),'count',1)) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN (platform_settings.value->>'window')::numeric=floor(extract(epoch FROM now())/60) THEN jsonb_set(platform_settings.value,'{count}',to_jsonb((platform_settings.value->>'count')::int+1)) ELSE jsonb_build_object('window',floor(extract(epoch FROM now())/60),'count',1) END RETURNING (value->>'count')::int AS count`,
    [key],
  );
  // At most 120 new keys/minute through the outer shared limit; bound retained rows.
  await db.query(
    "DELETE FROM platform_settings WHERE key LIKE 'passwordAuth:%' AND (value->>'window')::numeric < floor(extract(epoch FROM now())/60)-60",
  );
  return r.rows[0].count <= 10;
}
export function registerPasswordApplicationRoute(app: Hono<CloudEnv>) {
  app.post("/auth/web/register", async (c) => {
    const parsed = z
      .object({
        username: usernameSchema,
        password: passwordSchema,
        name: z.string().trim().min(1).max(80),
        reason: z.string().trim().max(500).default(""),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "请使用3–32位账号、10–128位密码，并填写姓名" },
        400,
      );
    if (!(await allowPasswordAttempt(parsed.data.username)))
      return c.json({ error: "该账号请求过于频繁，请一分钟后重试" }, 429);
    const data = parsed.data;
    const encoded = await hashPassword(data.password);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const hasAccount = !!(
        await client.query(
          "SELECT username FROM password_accounts WHERE username=$1",
          [data.username],
        )
      ).rowCount;
      const existing = (
        await client.query(
          "SELECT id,state FROM registration_requests WHERE username=$1 FOR UPDATE",
          [data.username],
        )
      ).rows[0];
      const action = registrationAction(hasAccount, existing?.state || null);
      if (action === "taken" || action === "pending") {
        await client.query("ROLLBACK");
        return c.json(
          {
            error:
              action === "pending"
                ? "申请正在审核，通过后即可登录"
                : "该账号已被使用",
          },
          409,
        );
      }
      if (action === "reapply")
        await client.query(
          "UPDATE registration_requests SET name=$2,reason=$3,password_hash=$4,state='pending',owner_id=NULL,reviewed_by=NULL,review_note='',reviewed_at=NULL,created_at=now() WHERE id=$1",
          [existing.id, data.name, data.reason, encoded],
        );
      else
        await client.query(
          "INSERT INTO registration_requests(id,username,name,reason,password_hash) VALUES($1,$2,$3,$4,$5)",
          [
            "reg_" + randomUUID().replaceAll("-", ""),
            data.username,
            data.name,
            data.reason,
            encoded,
          ],
        );
      await client.query("COMMIT");
      return c.json(
        {
          status: "pending",
          message: "申请已提交，管理员审核通过后即可登录",
        },
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        return c.json({ error: "该账号已申请或已被使用" }, 409);
      throw error;
    } finally {
      client.release();
    }
  });
}
export function registerPasswordAdminRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/admin/registration-requests", async (c) =>
    c.json({
      requests: (
        await db.query(
          "SELECT id,username,name,reason,state,owner_id,reviewed_by,review_note,created_at,reviewed_at FROM registration_requests ORDER BY (state='pending') DESC,created_at DESC LIMIT 200",
        )
      ).rows,
    }),
  );
  app.post("/v1/admin/registration-requests/:id/decision", async (c) => {
    const data = z
      .object({
        decision: z.enum(["approve", "reject"]),
        reason: z.string().trim().max(500).default(""),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: "审批参数无效" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const request = (
        await client.query(
          "SELECT * FROM registration_requests WHERE id=$1 FOR UPDATE",
          [c.req.param("id")],
        )
      ).rows[0];
      if (!request) {
        await client.query("ROLLBACK");
        return c.json({ error: "申请不存在" }, 404);
      }
      const state = data.data.decision === "approve" ? "approved" : "rejected";
      if (request.state !== "pending") {
        await client.query("ROLLBACK");
        return request.state === state
          ? c.json({ ok: true, state, ownerId: request.owner_id })
          : c.json({ error: "申请已经处理，不能重复更改" }, 409);
      }
      let ownerId = null;
      if (state === "approved") {
        ownerId = "user_" + randomUUID().replaceAll("-", "");
        await client.query(
          "INSERT INTO principals(id,name,role,token_hash) VALUES($1,$2,'member',$3)",
          [ownerId, request.name, hash(randomBytes(32).toString("hex"))],
        );
        await client.query(
          "INSERT INTO password_accounts(username,owner_id,password_hash) VALUES($1,$2,$3)",
          [request.username, ownerId, request.password_hash],
        );
      }
      await client.query(
        "UPDATE registration_requests SET state=$2,owner_id=$3,reviewed_by=$4,review_note=$5,reviewed_at=now(),password_hash=NULL WHERE id=$1",
        [request.id, state, ownerId, c.get("principal").id, data.data.reason],
      );
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        c.get("principal").id,
        `${state}-registration:${request.id}`,
      ]);
      await client.query("COMMIT");
      return c.json({ ok: true, state, ownerId });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        return c.json({ error: "该账号已被使用，无法批准" }, 409);
      throw error;
    } finally {
      client.release();
    }
  });
  app.get("/v1/admin/password-account", async (c) => {
    const row = (
      await db.query(
        "SELECT username FROM password_accounts WHERE owner_id=$1",
        [c.get("principal").id],
      )
    ).rows[0];
    return c.json({ configured: !!row, username: row?.username || null });
  });
  app.post("/v1/admin/password-account", async (c) => {
    const parsed = z
      .object({
        username: usernameSchema,
        password: passwordSchema,
        onlyIfUnconfigured: z.boolean().default(false),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "账号需3–32位，密码需10–128位" }, 400);
    const principal = c.get("principal");
    const client = await db.connect();
    try {
      const encoded = await hashPassword(parsed.data.password);
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        principal.id,
      ]);
      if (
        parsed.data.onlyIfUnconfigured &&
        (
          await client.query(
            "SELECT username FROM password_accounts WHERE owner_id=$1",
            [principal.id],
          )
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "管理员已经绑定账号，未修改现有密码" }, 409);
      }
      if (
        (
          await client.query(
            "SELECT id FROM registration_requests WHERE username=$1 AND state='pending'",
            [parsed.data.username],
          )
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "该账号正在申请中，请选择其他账号" }, 409);
      }
      await client.query(
        "INSERT INTO password_accounts(username,owner_id,password_hash) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET username=EXCLUDED.username,password_hash=EXCLUDED.password_hash",
        [parsed.data.username, principal.id, encoded],
      );
      await client.query("DELETE FROM auth_sessions WHERE owner_id=$1", [
        principal.id,
      ]);
      await client.query(
        "INSERT INTO audit(actor,action) VALUES($1,'update-admin-password')",
        [principal.id],
      );
      await client.query("COMMIT");
      return c.json({ ok: true, message: "密码已设置，请重新登录" });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        return c.json({ error: "该账号已被使用" }, 409);
      throw error;
    } finally {
      client.release();
    }
  });
}
