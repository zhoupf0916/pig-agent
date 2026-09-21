export const clusterSchema = `
CREATE TABLE IF NOT EXISTS worker_generations(worker_id text NOT NULL,instance_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(worker_id,instance_id));
CREATE TABLE IF NOT EXISTS run_completions(run_id text PRIMARY KEY REFERENCES runs(id),submission_id text NOT NULL,token_hash text NOT NULL,payload_hash text NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS receipt_id text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS instance_id text;
INSERT INTO worker_generations(worker_id,instance_id) SELECT id,instance_id FROM workers WHERE instance_id IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS reported_capacity int NOT NULL DEFAULT 3;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS profiles jsonb NOT NULL DEFAULT '["compact","standard","large"]';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS draining boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz;
CREATE TABLE IF NOT EXISTS dispatch_owners(owner_id text PRIMARY KEY,last_claimed_at timestamptz NOT NULL);
ALTER TABLE dispatch_owners DROP CONSTRAINT IF EXISTS dispatch_owners_owner_id_fkey;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS event_idempotency ON events(run_id,event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_dispatch ON runs(state,created_at);
CREATE OR REPLACE FUNCTION limit_run_queue() RETURNS trigger AS $$
DECLARE queue_limit int;
BEGIN
  PERFORM pg_advisory_xact_lock(71839023);
  queue_limit := COALESCE((SELECT (value->>'queueLimit')::int FROM platform_settings WHERE key='executionPolicy'),200);
  IF (SELECT count(*) FROM runs WHERE state='queued') >= queue_limit THEN
    RAISE EXCEPTION 'Queue capacity exceeded' USING ERRCODE='P0429';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS limit_run_queue ON runs;
CREATE TRIGGER limit_run_queue BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION limit_run_queue();
`;
