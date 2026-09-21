import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function desktopAuth(token: Buffer): MiddlewareHandler {
  return async (c, next) => {
    const auth = Buffer.from(
      c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    );
    if (auth.length !== token.length || !timingSafeEqual(auth, token))
      return c.json({ error: "Unauthorized" }, 401);
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: "Forbidden origin" }, 403);
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  };
}
