import pg from "pg";
import { createHash } from "node:crypto";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS principals (id text PRIMARY KEY, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')), token_hash text UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES principals(id), request_key text, input jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', worker_id text, lease_until timestamptz, attempt_token text, model_calls int NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,request_key));
    CREATE TABLE IF NOT EXISTS events (seq bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), event jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), path text NOT NULL, content text NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now());
  `);
  for (const [id, name, role, token] of [
    ["admin", "本机管理员", "admin", process.env.ADMIN_TOKEN],
    ["member", "本机体验账号", "member", process.env.MEMBER_TOKEN],
    ["member2", "隔离验证账号", "member", process.env.MEMBER2_TOKEN],
  ]) {
    if (!token) throw Error("Missing bootstrap credential");
    await db.query(
      "INSERT INTO principals VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=$4",
      [id, name, role, hash(token)],
    );
  }
}
export const terminal = (state: string) =>
  ["succeeded", "failed", "cancelled"].includes(state);
