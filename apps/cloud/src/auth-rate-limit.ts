import { isIP } from "node:net";
import type { Context } from "hono";
import { db, hash } from "./db.ts";
export { authRateLimitSchema } from "./auth-rate-limit-schema.ts";

/**
 * Login throttling keyed by client IP and by account, replacing the former single global bucket
 * (120/min shared by everyone), which any distributed sender could exhaust to lock every user out.
 * Fixed windows in Postgres keep limits authoritative across control-plane replicas.
 */

export const AUTH_LIMITS = {
  /** Any /auth/web/* request (except logout) from one client IP. */
  ip: { windowSeconds: 60, max: 30 },
  /** Failed password logins for one account from one IP. */
  accountIpFailures: { windowSeconds: 900, max: 5 },
  /** Failed password logins for one account from all IPs (slows distributed guessing). */
  accountFailures: { windowSeconds: 900, max: 50 },
  /** Failed token logins from one IP. */
  tokenFailures: { windowSeconds: 900, max: 10 },
  /** Registration applications per username. */
  registration: { windowSeconds: 60, max: 10 },
} as const;
export type AuthLimit = keyof typeof AUTH_LIMITS;

/** Adds `increment` (0 = read only) to the current window and returns the window's count. */
export async function hitBucket(limit: AuthLimit, key: string, increment = 1) {
  const { windowSeconds } = AUTH_LIMITS[limit];
  const r = await db.query(
    `INSERT INTO auth_rate_limits(bucket,window_id,count,expires_at)
     VALUES($1,floor(extract(epoch FROM now())/$2)::bigint,$3,now()+make_interval(secs=>$2::int))
     ON CONFLICT(bucket) DO UPDATE SET
       count=CASE WHEN auth_rate_limits.window_id=EXCLUDED.window_id THEN auth_rate_limits.count+EXCLUDED.count ELSE EXCLUDED.count END,
       window_id=EXCLUDED.window_id,expires_at=EXCLUDED.expires_at
     RETURNING count`,
    [limit + ":" + key, windowSeconds, increment],
  );
  if (Math.random() < 0.02)
    void db.query("DELETE FROM auth_rate_limits WHERE expires_at<now()").catch(() => {});
  return Number(r.rows[0]?.count ?? 0);
}
export const overLimit = (limit: AuthLimit, count: number) => count > AUTH_LIMITS[limit].max;
/** True when the account (from this IP, or overall) already has too many recent failures. */
export async function passwordLoginBlocked(username: string, ip: string) {
  const user = hash(username);
  const [pair, all] = await Promise.all([
    hitBucket("accountIpFailures", user + ":" + ip, 0),
    hitBucket("accountFailures", user, 0),
  ]);
  return pair >= AUTH_LIMITS.accountIpFailures.max || all >= AUTH_LIMITS.accountFailures.max;
}
export async function recordPasswordFailure(username: string, ip: string) {
  const user = hash(username);
  await Promise.all([
    hitBucket("accountIpFailures", user + ":" + ip),
    hitBucket("accountFailures", user),
  ]);
}
export async function clearPasswordFailures(username: string, ip: string) {
  await db.query("DELETE FROM auth_rate_limits WHERE bucket=$1", [
    "accountIpFailures:" + hash(username) + ":" + ip,
  ]);
}

/**
 * Client IP for throttling. A proxy header is trusted only when TRUST_PROXY_HEADER names it
 * (production Nginx overwrites X-Forwarded-For with $remote_addr); otherwise the socket peer is used.
 */
export function clientIp(c: Context): string {
  const header = process.env.TRUST_PROXY_HEADER?.trim().toLowerCase();
  if (header) {
    const value = c.req.header(header)?.split(",")[0]?.trim();
    if (value && isIP(value)) return value;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress;
  return peer && isIP(peer) ? peer : "unknown";
}
