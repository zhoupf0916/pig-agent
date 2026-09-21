import pg from "pg";
import { createHash } from "node:crypto";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function migrate() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71839021)");
    await client.query(`
    CREATE TABLE IF NOT EXISTS principals (id text PRIMARY KEY, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')), token_hash text UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES principals(id), request_key text, input jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', worker_id text, lease_until timestamptz, attempt_token text, model_calls int NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,request_key));
    CREATE TABLE IF NOT EXISTS schedules (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES principals(id), request_key text,
      name text NOT NULL, input jsonb NOT NULL, cron text, timezone text NOT NULL,
      enabled boolean NOT NULL DEFAULT true, misfire text NOT NULL DEFAULT 'skip',
      next_fire_at timestamptz, last_run_id text, last_run_at timestamptz, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz, UNIQUE(owner_id,request_key)
    );
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_fire_at) WHERE enabled AND deleted_at IS NULL;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS schedule_id text REFERENCES schedules(id);
    CREATE TABLE IF NOT EXISTS schedule_firings (
      schedule_id text NOT NULL REFERENCES schedules(id), scheduled_at timestamptz NOT NULL,
      outcome text NOT NULL, run_id text REFERENCES runs(id), PRIMARY KEY(schedule_id,scheduled_at)
    );
    CREATE TABLE IF NOT EXISTS events (seq bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), event jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), path text NOT NULL, content text NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS capacity int NOT NULL DEFAULT 3 CHECK(capacity BETWEEN 1 AND 16);
    CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now());
  `);
    for (const [id, name, role, token] of [
      ["admin", "本机管理员", "admin", process.env.ADMIN_TOKEN],
      ["member", "本机体验账号", "member", process.env.MEMBER_TOKEN],
      ["member2", "隔离验证账号", "member", process.env.MEMBER2_TOKEN],
    ]) {
      if (!token) throw Error("Missing bootstrap credential");
      await client.query(
        "INSERT INTO principals VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=$4",
        [id, name, role, hash(token)],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled"].includes(state);
