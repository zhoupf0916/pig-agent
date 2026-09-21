import pg from "pg";
import { clusterSchema } from "./cluster-schema.ts";
import { createHash } from "node:crypto";
import { collaborationSchema } from "./collaboration-schema.ts";
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
    ALTER TABLE principals ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE principals ADD COLUMN IF NOT EXISTS daily_call_limit int NOT NULL DEFAULT 1000;
    CREATE TABLE IF NOT EXISTS invitations(token_hash text PRIMARY KEY,name text NOT NULL,expires_at timestamptz NOT NULL);
    ALTER TABLE invitations ADD COLUMN IF NOT EXISTS owner_id text REFERENCES principals(id);
    CREATE TABLE IF NOT EXISTS auth_sessions(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS model_channels(id text PRIMARY KEY,name text NOT NULL,base_url text NOT NULL,model text NOT NULL,secret text NOT NULL,enabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_channel ON model_channels(enabled) WHERE enabled;
    CREATE TABLE IF NOT EXISTS model_usage(id bigserial PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),run_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS usage_owner_time ON model_usage(owner_id,created_at);
    CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES principals(id), request_key text, input jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', worker_id text, lease_until timestamptz, attempt_token text, model_calls int NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,request_key));
    CREATE TABLE IF NOT EXISTS platform_settings(key text PRIMARY KEY,value jsonb NOT NULL);
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_profile text NOT NULL DEFAULT 'standard';
    CREATE OR REPLACE FUNCTION pin_run_profile() RETURNS trigger AS $$
    BEGIN NEW.execution_profile := COALESCE((SELECT value #>> '{}' FROM platform_settings WHERE key='executionProfile'),'standard'); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS pin_run_profile ON runs;
    CREATE TRIGGER pin_run_profile BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION pin_run_profile();
    CREATE TABLE IF NOT EXISTS execution_attempts(id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),worker_id text NOT NULL,resources jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS conversations (
      id text PRIMARY KEY, owner_id text NOT NULL REFERENCES principals(id), title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS conversation_id text REFERENCES conversations(id);
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES runs(id);
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_active_run ON runs(conversation_id)
      WHERE state IN ('queued','preparing','running','cancelling');
    CREATE TABLE IF NOT EXISTS workspace_versions (
      run_id text PRIMARY KEY REFERENCES runs(id), conversation_id text NOT NULL REFERENCES conversations(id),
      snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
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
    CREATE TABLE IF NOT EXISTS approvals(id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),call_id text NOT NULL,tool text NOT NULL,args jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','consumed')),created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,decided_by text REFERENCES principals(id),UNIQUE(run_id,call_id));
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), path text NOT NULL, content text NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS capacity int NOT NULL DEFAULT 3 CHECK(capacity BETWEEN 1 AND 16);
    CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now());
  `);
    await client.query(collaborationSchema);
    await client.query(clusterSchema);
    for (const [id, name, role, token] of [
      ["admin", "本机管理员", "admin", process.env.ADMIN_TOKEN],
      ["member", "本机体验账号", "member", process.env.MEMBER_TOKEN],
      ["member2", "隔离验证账号", "member", process.env.MEMBER2_TOKEN],
    ]) {
      if (!token) throw Error("Missing bootstrap credential");
      await client.query(
        "INSERT INTO principals(id,name,role,token_hash) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=$4",
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
