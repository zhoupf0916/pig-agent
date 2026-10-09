import { billingSchema } from "./billing.ts";
import { ecosystemPluginSchema } from "./ecosystem-plugins.ts";
import { mcpServerSchema } from "./mcp-schema.ts";
import { attachmentSchema } from "./attachments.ts";
import { capabilitySchema } from "./capabilities.ts";
import { fileEditSchema } from "./file-edits.ts";
import { userDataSchema } from "./user-data-schema.ts";
import { passwordAccountSchema } from "./password-schema.ts";
import { clusterSchema } from "./cluster-schema.ts";
import { collaborationSchema } from "./collaboration-schema.ts";
import { bootstrapTokenSchema } from "./bootstrap-tokens.ts";
import { authRateLimitSchema } from "./auth-rate-limit-schema.ts";
import type { Migration } from "./migrations.ts";

// Schema as it stood before versioned migrations (idempotent: a no-op on an existing database).
// Frozen: its checksum is recorded in schema_migrations, so do not edit this or the *Schema
// constants it composes; put every schema change in a new migration below.
const coreSchema = `
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
    ${billingSchema}
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
    ALTER TABLE schedule_firings ADD COLUMN IF NOT EXISTS device_id text;
    ALTER TABLE schedule_firings ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE schedule_firings ADD COLUMN IF NOT EXISTS request_key text;
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_firing_request ON schedule_firings(schedule_id, request_key) WHERE request_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS events (seq bigserial PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), event jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),call_id text NOT NULL,tool text NOT NULL,args jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','consumed')),created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,decided_by text REFERENCES principals(id),UNIQUE(run_id,call_id));
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS execution_remaining_ms bigint;
    CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), path text NOT NULL, content text NOT NULL);
    CREATE TABLE IF NOT EXISTS workers (id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE workers ADD COLUMN IF NOT EXISTS capacity int NOT NULL DEFAULT 3 CHECK(capacity BETWEEN 1 AND 16);
    CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, run_id text, created_at timestamptz NOT NULL DEFAULT now());
`;

// Built lazily: several schema modules import db.ts, which imports this file.
const baseline = () => [
  coreSchema,
  passwordAccountSchema,
  userDataSchema,
  collaborationSchema,
  capabilitySchema,
  fileEditSchema,
  ecosystemPluginSchema,
  mcpServerSchema,
  attachmentSchema,
  clusterSchema,
  bootstrapTokenSchema,
  authRateLimitSchema,
].join(";\n");

// Wake-up notifications for the in-process event bus (event-bus.ts). Payloads are keys, never data.
const eventBusTriggers = `
CREATE OR REPLACE FUNCTION pig_bus_events() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', k) FROM (
    SELECT DISTINCT 'ev:' || n.run_id AS k FROM pig_new_events n
    UNION SELECT DISTINCT 'conv:' || r.conversation_id FROM pig_new_events n JOIN runs r ON r.id = n.run_id WHERE r.conversation_id IS NOT NULL
  ) keys;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_events ON events;
CREATE TRIGGER pig_bus_events AFTER INSERT ON events REFERENCING NEW TABLE AS pig_new_events
  FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_events();

CREATE OR REPLACE FUNCTION pig_bus_runs() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'run:' || NEW.id);
  IF NEW.conversation_id IS NOT NULL THEN PERFORM pg_notify('pig_bus', 'conv:' || NEW.conversation_id); END IF;
  IF TG_OP = 'UPDATE' AND OLD.conversation_id IS NOT NULL AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    PERFORM pg_notify('pig_bus', 'conv:' || OLD.conversation_id);
  END IF;
  -- New work, requeues and freed concurrency all change what a worker can claim.
  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN PERFORM pg_notify('pig_bus', 'queue'); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_runs_insert ON runs;
CREATE TRIGGER pig_bus_runs_insert AFTER INSERT ON runs FOR EACH ROW EXECUTE FUNCTION pig_bus_runs();
DROP TRIGGER IF EXISTS pig_bus_runs_update ON runs;
CREATE TRIGGER pig_bus_runs_update AFTER UPDATE ON runs FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.error IS DISTINCT FROM NEW.error
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at OR OLD.conversation_id IS DISTINCT FROM NEW.conversation_id)
  EXECUTE FUNCTION pig_bus_runs();

CREATE OR REPLACE FUNCTION pig_bus_approvals() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'approval:' || NEW.id);
  PERFORM pg_notify('pig_bus', 'run:' || NEW.run_id);
  PERFORM pg_notify('pig_bus', 'conv:' || r.conversation_id) FROM runs r WHERE r.id = NEW.run_id AND r.conversation_id IS NOT NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_approvals ON approvals;
CREATE TRIGGER pig_bus_approvals AFTER INSERT OR UPDATE OF state ON approvals FOR EACH ROW EXECUTE FUNCTION pig_bus_approvals();

CREATE OR REPLACE FUNCTION pig_bus_versions() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'conv:' || NEW.conversation_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_versions ON workspace_versions;
CREATE TRIGGER pig_bus_versions AFTER INSERT ON workspace_versions FOR EACH ROW EXECUTE FUNCTION pig_bus_versions();

CREATE OR REPLACE FUNCTION pig_bus_conversations() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'convrow:' || OLD.id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_conversations ON conversations;
CREATE TRIGGER pig_bus_conversations AFTER UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION pig_bus_conversations();

CREATE OR REPLACE FUNCTION pig_bus_workers() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'worker:' || NEW.id);
  PERFORM pg_notify('pig_bus', 'queue');
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_workers ON workers;
CREATE TRIGGER pig_bus_workers AFTER UPDATE ON workers FOR EACH ROW
  WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.capacity IS DISTINCT FROM NEW.capacity
    OR OLD.draining IS DISTINCT FROM NEW.draining OR OLD.reported_capacity IS DISTINCT FROM NEW.reported_capacity
    OR OLD.instance_id IS DISTINCT FROM NEW.instance_id)
  EXECUTE FUNCTION pig_bus_workers();

-- Identity, session and membership changes: open streams re-check access immediately.
CREATE OR REPLACE FUNCTION pig_bus_auth() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pig_bus', 'auth');
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_bus_auth ON principals;
CREATE TRIGGER pig_bus_auth AFTER UPDATE OR DELETE ON principals FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_auth();
DROP TRIGGER IF EXISTS pig_bus_auth ON auth_sessions;
CREATE TRIGGER pig_bus_auth AFTER UPDATE OR DELETE ON auth_sessions FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_auth();
DROP TRIGGER IF EXISTS pig_bus_auth ON space_members;
CREATE TRIGGER pig_bus_auth AFTER INSERT OR UPDATE OR DELETE ON space_members FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_auth();
DROP TRIGGER IF EXISTS pig_bus_auth ON shared_projects;
CREATE TRIGGER pig_bus_auth AFTER UPDATE OR DELETE ON shared_projects FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_auth();
DROP TRIGGER IF EXISTS pig_bus_auth ON spaces;
CREATE TRIGGER pig_bus_auth AFTER UPDATE OR DELETE ON spaces FOR EACH STATEMENT EXECUTE FUNCTION pig_bus_auth();
`;

export const migrations = (): Migration[] => [
  { version: 1, name: "baseline", sql: baseline() },
  { version: 2, name: "event_bus_triggers", sql: eventBusTriggers },
];
