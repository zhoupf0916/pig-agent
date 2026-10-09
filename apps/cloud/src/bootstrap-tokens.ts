import { createHash } from "node:crypto";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Static env bearer accounts used by local/dev stacks and by first-time admin bootstrap. */
export const BOOTSTRAP_PRINCIPALS = [
  { id: "admin", name: "本机管理员", role: "admin", env: "ADMIN_TOKEN", required: true },
  { id: "member", name: "本机体验账号", role: "member", env: "MEMBER_TOKEN", required: false },
  // Test-only isolation account: disabled whenever its credential is not configured (production).
  { id: "member2", name: "隔离验证账号", role: "member", env: "MEMBER2_TOKEN", required: false, disableWhenUnset: true },
] as const;

/** SQL predicate: a principal's static bearer token is usable (not expired, not revoked). */
export const STATIC_TOKEN_LIVE =
  "(token_expires_at IS NULL OR token_expires_at>now()) AND token_revoked_at IS NULL";

export const bootstrapTokenSchema = `
ALTER TABLE principals ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE principals ADD COLUMN IF NOT EXISTS token_revoked_at timestamptz;
`;

/** Hours a bootstrap bearer stays valid after it is first configured; null keeps the legacy non-expiring behaviour. */
export function bootstrapTtlHours(env: Record<string, string | undefined>): number | null {
  const raw = env.BOOTSTRAP_TOKEN_TTL_HOURS?.trim();
  if (!raw) return null;
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760)
    throw Error("BOOTSTRAP_TOKEN_TTL_HOURS must be an integer between 1 and 8760");
  return hours;
}

type Query = (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;

/**
 * Reconcile env bootstrap credentials with the principals table.
 * - Same token as before keeps its expiry window and any admin revocation (restarts cannot revive it).
 * - A rotated token starts a fresh window and clears revocation.
 * - An unset optional token revokes the stored one; member2 is also disabled.
 */
export async function syncBootstrapPrincipals(
  client: { query: Query },
  env: Record<string, string | undefined> = process.env,
) {
  const ttl = bootstrapTtlHours(env);
  const summary: Record<string, "active" | "revoked" | "absent"> = {};
  for (const p of BOOTSTRAP_PRINCIPALS) {
    const token = env[p.env]?.trim();
    if (!token) {
      if (p.required) throw Error("Missing bootstrap credential");
      const r = await client.query(
        `UPDATE principals SET token_revoked_at=coalesce(token_revoked_at,now())${
          "disableWhenUnset" in p ? ",enabled=false" : ""
        } WHERE id=$1 AND (token_revoked_at IS NULL${"disableWhenUnset" in p ? " OR enabled" : ""})`,
        [p.id],
      );
      if (r.rowCount)
        await client.query("INSERT INTO audit(actor,action) VALUES('system',$1)", [
          "bootstrap-token-revoked:" + p.id,
        ]);
      summary[p.id] = r.rowCount ? "revoked" : "absent";
      continue;
    }
    await client.query(
      `INSERT INTO principals(id,name,role,token_hash,token_expires_at)
       VALUES($1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE now()+make_interval(hours=>$5::int) END)
       ON CONFLICT(id) DO UPDATE SET
         token_revoked_at=CASE WHEN principals.token_hash=$4 THEN principals.token_revoked_at ELSE NULL END,
         token_expires_at=CASE
           WHEN $5::int IS NULL THEN NULL
           WHEN principals.token_hash=$4 AND principals.token_expires_at IS NOT NULL THEN principals.token_expires_at
           ELSE now()+make_interval(hours=>$5::int) END,
         token_hash=$4`,
      [p.id, p.name, p.role, hash(token), ttl],
    );
    summary[p.id] = "active";
  }
  return summary;
}
