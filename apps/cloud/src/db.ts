import pg from "pg";
import { createHash } from "node:crypto";
import { syncBootstrapPrincipals } from "./bootstrap-tokens.ts";
import { MIGRATION_LOCK, runMigrations } from "./migrations.ts";
import { migrations } from "./schema.ts";
// Explicit pool size: SSE streams and long-polls hold no connection while waiting, so a small pool
// serves many clients. The event bus uses one extra dedicated connection per process.
export const POOL_MAX = Math.max(2, Math.min(100, Number(process.env.PG_POOL_MAX) || 10));
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: POOL_MAX });
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function migrate() {
  const client = await db.connect();
  try {
    await runMigrations(client, migrations());
    // Bootstrap principals follow the environment on every start, not a schema version.
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await syncBootstrapPrincipals(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    client.release();
  }
}
export const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled"].includes(state);
