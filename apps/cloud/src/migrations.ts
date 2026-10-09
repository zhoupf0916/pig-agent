import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Versioned, forward-only schema migrations.
 *
 * Rules (expand → migrate → contract):
 * - Never edit a migration that has shipped; add a new version instead (checksums are verified).
 * - A release may only *expand* the schema (new tables, nullable/defaulted columns, new indexes) so the
 *   previous release keeps working against it. Drops/renames happen one release later, once no running
 *   code reads the old shape.
 * - `transaction: false` is for statements Postgres refuses inside a transaction
 *   (e.g. `CREATE INDEX CONCURRENTLY`); such a migration must be safe to re-run.
 */
export type Migration = {
  version: number;
  name: string;
  sql: string;
  transaction?: boolean;
};

export type MigrationPlan = {
  applied: { version: number; name: string; appliedAt: Date }[];
  pending: Migration[];
  /** Versions recorded in the database that this build does not know (database is ahead, e.g. after an app rollback). */
  unknown: number[];
};

export type Queryable = Pick<pg.PoolClient, "query">;

/** Same key the pre-versioned migrate() used, so old and new instances still serialize. */
export const MIGRATION_LOCK = 71839021;

export const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

export const migrationTableSql = `CREATE TABLE IF NOT EXISTS schema_migrations(
  version int PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function validateMigrations(migrations: Migration[]) {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous)
      throw new Error(`Migration versions must be increasing integers (at ${migration.version} ${migration.name})`);
    previous = migration.version;
  }
}

async function recorded(client: Queryable) {
  const exists = await client.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`);
  if (!exists.rows[0]?.ok) return [];
  const { rows } = await client.query(
    `SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`,
  );
  return rows as { version: number; name: string; checksum: string; applied_at: Date }[];
}

export async function planMigrations(client: Queryable, migrations: Migration[]): Promise<MigrationPlan> {
  validateMigrations(migrations);
  const rows = await recorded(client);
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const row of rows) {
    const migration = known.get(row.version);
    if (migration && checksum(migration.sql) !== row.checksum)
      throw new Error(
        `Migration ${row.version} (${row.name}) was changed after it was applied; add a new migration instead`,
      );
  }
  const done = new Set(rows.map((row) => row.version));
  return {
    applied: rows.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at })),
    pending: migrations.filter((m) => !done.has(m.version)),
    unknown: rows.filter((row) => !known.has(row.version)).map((row) => row.version),
  };
}

/**
 * Applies pending migrations under a session advisory lock. Each transactional migration commits
 * together with its schema_migrations row, so a failure leaves earlier versions applied and later
 * ones pending.
 */
export async function runMigrations(
  client: Queryable,
  migrations: Migration[],
  log: (line: string) => void = console.log,
) {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
  try {
    await client.query(migrationTableSql);
    const plan = await planMigrations(client, migrations);
    if (plan.unknown.length)
      log(`Database has newer migrations (${plan.unknown.join(", ")}); continuing because releases are expand-only`);
    for (const migration of plan.pending) {
      const started = Date.now();
      const record = () =>
        client.query(`INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)`, [
          migration.version,
          migration.name,
          checksum(migration.sql),
        ]);
      if (migration.transaction === false) {
        await client.query(migration.sql);
        await record();
      } else {
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await record();
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      log(`Applied migration ${migration.version} ${migration.name} in ${Date.now() - started} ms`);
    }
    return plan;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  }
}
