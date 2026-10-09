import pg from "pg";
import { createHash } from "node:crypto";
import { syncBootstrapPrincipals } from "./bootstrap-tokens.ts";
import { MIGRATION_LOCK, runMigrations } from "./migrations.ts";
import { migrations } from "./schema.ts";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
