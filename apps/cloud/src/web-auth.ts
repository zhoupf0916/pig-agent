import {
  usernameSchema,
  passwordSchema,
  loginWithPassword,
  loginFailure,
  registerPasswordApplicationRoute,
  PasswordWorkBusy,
} from "./password-accounts.ts";
import {
  AUTH_LIMITS,
  clearPasswordFailures,
  clientIp,
  hitBucket,
  overLimit,
  passwordLoginBlocked,
  recordPasswordFailure,
} from "./auth-rate-limit.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { db, hash } from "./db.ts";
import { acceptInvitation } from "./platform.ts";
import type { CloudEnv } from "./types.ts";
import { STATIC_TOKEN_LIVE } from "./bootstrap-tokens.ts";

export const WEB_SESSION_COOKIE = "pig_web_session";
const SESSION_SECONDS = 12 * 60 * 60;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
export function getRequestCredential(c: Context) {
  const authorization = c.req.header("Authorization");
  if (authorization !== undefined)
    return {
      token: /^Bearer [^\s]+$/.test(authorization)
        ? authorization.slice(7)
        : "",
      source: "bearer" as const,
    };
  const token = getCookie(c, WEB_SESSION_COOKIE) || "";
  return { token, source: token ? ("cookie" as const) : ("none" as const) };
}
function publicOrigin(c: Context) {
  return process.env.WEB_PUBLIC_ORIGIN
    ? new URL(process.env.WEB_PUBLIC_ORIGIN).origin
    : new URL(c.req.url).origin;
}
export function validateWebOrigin(c: Context) {
  const origin = c.req.header("Origin");
  return (
    !!origin &&
    origin === publicOrigin(c) &&
    c.req.header("Sec-Fetch-Site") !== "cross-site"
  );
}
export const authenticateWebOrBearer: MiddlewareHandler<CloudEnv> = async (
  c,
  next,
) => {
  const credential = getRequestCredential(c);
  if (
    credential.source === "cookie" &&
    !safeMethods.has(c.req.method) &&
    !validateWebOrigin(c)
  )
    return c.json({ error: "请求来源无效，请从本站重新操作" }, 403);
  if (!credential.token || credential.token.length > 200)
    return c.json({ error: "请登录后继续" }, 401);
  const found = await db.query(
    credential.source === "cookie"
      ? "SELECT id,role,name FROM principals WHERE enabled AND id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>now())"
      : `SELECT id,role,name FROM principals WHERE enabled AND ((token_hash=$1 AND ${STATIC_TOKEN_LIVE}) OR id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()))`,
    [hash(credential.token)],
  );
  if (!found.rowCount) return c.json({ error: "登录已失效，请重新登录" }, 401);
  c.set("principal", found.rows[0]);
  await next();
};
function issueCookie(c: Context, token: string) {
  setCookie(c, WEB_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: publicOrigin(c).startsWith("https:"),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}
export function registerWebAuthRoutes(app: Hono<CloudEnv>) {
  app.use("/auth/web/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!safeMethods.has(c.req.method) && !validateWebOrigin(c))
      return c.json({ error: "请求来源无效" }, 403);
    if (
      c.req.path !== "/auth/web/logout" &&
      overLimit("ip", await hitBucket("ip", clientIp(c)))
    ) {
      c.header("Retry-After", "60");
      return c.json({ error: "登录请求过于频繁，请稍后重试" }, 429);
    }
    await next();
  });
  registerPasswordApplicationRoute(app);
  app.post("/auth/web/login", async (c) => {
    const parsed = z
      .union([
        z.object({ token: z.string().trim().min(1).max(200) }).strict(),
        z
          .object({ username: usernameSchema, password: passwordSchema })
          .strict(),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "请输入有效账号和密码" }, 400);
    let passwordAccount: {
      id: string;
      role: string;
      name: string;
      credentialHash: string;
    } | null = null;
    const ip = clientIp(c);
    if ("username" in parsed.data) {
      const { username, password } = parsed.data;
      if (await passwordLoginBlocked(username, ip)) {
        c.header("Retry-After", "900");
        return c.json({ error: "该账号登录失败次数过多，请15分钟后重试" }, 429);
      }
      let attempt: Awaited<ReturnType<typeof loginWithPassword>>;
      try {
        attempt = await loginWithPassword(username, password);
      } catch (error) {
        if (error instanceof PasswordWorkBusy) {
          c.header("Retry-After", "5");
          return c.json({ error: "登录服务繁忙，请稍后重试" }, 503);
        }
        throw error;
      }
      if (!attempt.ok) {
        if (attempt.reason === "invalid")
          await recordPasswordFailure(username, ip);
        const failure = loginFailure(attempt.reason);
        return c.json({ error: failure.error }, failure.status);
      }
      await clearPasswordFailures(username, ip);
      passwordAccount = attempt;
    } else if (
      (await hitBucket("tokenFailures", ip, 0)) >=
      AUTH_LIMITS.tokenFailures.max
    ) {
      c.header("Retry-After", "900");
      return c.json({ error: "登录失败次数过多，请15分钟后重试" }, 429);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const account = passwordAccount
        ? (
            await client.query(
              "SELECT p.id,p.role,p.name FROM principals p JOIN password_accounts a ON a.owner_id=p.id WHERE p.id=$1 AND p.enabled AND a.password_hash=$2 FOR UPDATE OF p",
              [passwordAccount.id, passwordAccount.credentialHash],
            )
          ).rows[0]
        : (
            await client.query(
              `SELECT id,role,name FROM principals WHERE enabled AND ((token_hash=$1 AND ${STATIC_TOKEN_LIVE}) OR id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>now())) FOR UPDATE`,
              ["token" in parsed.data ? hash(parsed.data.token) : ""],
            )
          ).rows[0];
      if (!account) {
        await client.query("ROLLBACK");
        if (!passwordAccount) await hitBucket("tokenFailures", ip);
        return c.json({ error: "访问令牌无效或已过期" }, 401);
      }
      const token = randomBytes(32).toString("hex");
      await client.query(
        "INSERT INTO auth_sessions(id,owner_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
        [randomUUID(), account.id, hash(token)],
      );
      await client.query("COMMIT");
      issueCookie(c, token);
      return c.json({ account, expiresInSeconds: SESSION_SECONDS });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.post("/auth/web/invite", async (c) => {
    const parsed = z
      .object({ invite: z.string().trim().min(32).max(100) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "请输入有效的邀请凭证" }, 400);
    const result = await acceptInvitation(parsed.data.invite, 12);
    if (result.status !== 201)
      return c.json({ error: result.error }, result.status);
    issueCookie(c, result.token);
    return c.json(
      { account: result.account, expiresInSeconds: SESSION_SECONDS },
      201,
    );
  });
  app.post("/auth/web/logout", async (c) => {
    const token = getCookie(c, WEB_SESSION_COOKIE);
    if (token)
      await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        hash(token),
      ]);
    deleteCookie(c, WEB_SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      secure: publicOrigin(c).startsWith("https:"),
      sameSite: "Strict",
    });
    return c.json({ ok: true });
  });
}
