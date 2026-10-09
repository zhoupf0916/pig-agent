// Migration 0003: signed outbound webhooks (expand-only). Triggers form a transactional outbox: a delivery row is
// written in the same transaction as the run/approval change, and `pig_bus` wakes the dispatcher.
export const webhookSchemaSql = `
CREATE TABLE IF NOT EXISTS webhooks(
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  events text[] NOT NULL,
  secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_owner ON webhooks(owner_id) WHERE enabled;
CREATE TABLE IF NOT EXISTS webhook_deliveries(
  id text PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivering','succeeded','dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_status int,
  last_error text,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE state IN ('pending','delivering');
CREATE INDEX IF NOT EXISTS webhook_deliveries_log ON webhook_deliveries(webhook_id, created_at DESC);

CREATE OR REPLACE FUNCTION pig_webhook_enqueue(p_owner text, p_event text, p_event_id text, p_payload jsonb) RETURNS void AS $$
BEGIN
  INSERT INTO webhook_deliveries(id, webhook_id, event_id, event, payload)
  SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), w.id, p_event_id, p_event, p_payload
  FROM webhooks w WHERE w.owner_id = p_owner AND w.enabled AND p_event = ANY(w.events)
  ON CONFLICT (webhook_id, event_id) DO NOTHING;
  IF FOUND THEN PERFORM pg_notify('pig_bus', 'webhooks'); END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pig_webhook_utc(t timestamptz) RETURNS text AS $$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pig_webhook_runs() RETURNS trigger AS $$
DECLARE event_id text;
BEGIN
  -- Cheap exit for the common case: owners without webhooks pay one index probe, no payload build.
  IF NOT EXISTS (SELECT 1 FROM webhooks WHERE owner_id = NEW.owner_id AND enabled) THEN RETURN NULL; END IF;
  -- Stable per terminal transition (a recovered run that ends again gets a new id).
  event_id := 'evt_' || md5(NEW.id || ':' || NEW.state || ':' || coalesce(NEW.recovery_count, 0));
  PERFORM pig_webhook_enqueue(NEW.owner_id, 'run.' || NEW.state, event_id, jsonb_build_object(
    'id', event_id, 'type', 'run.' || NEW.state, 'createdAt', pig_webhook_utc(now()),
    'data', jsonb_build_object('run', jsonb_build_object(
      'id', NEW.id, 'state', NEW.state, 'error', NEW.error, 'conversationId', NEW.conversation_id,
      'projectId', NEW.project_id, 'createdAt', pig_webhook_utc(NEW.created_at), 'updatedAt', pig_webhook_utc(NEW.updated_at)))));
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_webhook_runs ON runs;
CREATE TRIGGER pig_webhook_runs AFTER UPDATE OF state ON runs FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('succeeded','failed','cancelled'))
  EXECUTE FUNCTION pig_webhook_runs();

CREATE OR REPLACE FUNCTION pig_webhook_approvals() RETURNS trigger AS $$
DECLARE event_id text := 'evt_' || md5('approval:' || NEW.id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhooks w JOIN runs r ON r.owner_id = w.owner_id WHERE r.id = NEW.run_id AND w.enabled) THEN RETURN NULL; END IF;
  PERFORM pig_webhook_enqueue(r.owner_id, 'approval.requested', event_id, jsonb_build_object(
    'id', event_id, 'type', 'approval.requested', 'createdAt', pig_webhook_utc(now()),
    'data', jsonb_build_object(
      'approval', jsonb_build_object('id', NEW.id, 'runId', NEW.run_id, 'tool', NEW.tool, 'createdAt', pig_webhook_utc(NEW.created_at)),
      'run', jsonb_build_object('id', r.id, 'conversationId', r.conversation_id, 'projectId', r.project_id))))
  FROM runs r WHERE r.id = NEW.run_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pig_webhook_approvals ON approvals;
CREATE TRIGGER pig_webhook_approvals AFTER INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION pig_webhook_approvals();
`;
