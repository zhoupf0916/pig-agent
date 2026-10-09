// Migration 0004: trace spans (head-sampled, retained 7 days) and alert history (expand-only).
export const observabilitySchemaSql = `
CREATE TABLE IF NOT EXISTS trace_spans(
  trace_id text NOT NULL,
  span_id text NOT NULL,
  parent_span_id text,
  service text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  start_time timestamptz NOT NULL,
  duration_ms double precision NOT NULL,
  status text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS trace_spans_created ON trace_spans(created_at);
CREATE INDEX IF NOT EXISTS trace_spans_roots ON trace_spans(start_time DESC) WHERE parent_span_id IS NULL;
CREATE TABLE IF NOT EXISTS alerts(
  id bigserial PRIMARY KEY,
  rule text NOT NULL,
  severity text NOT NULL CHECK(severity IN ('info','warning','critical')),
  state text NOT NULL CHECK(state IN ('firing','resolved')),
  summary text NOT NULL,
  value double precision,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_firing ON alerts(rule) WHERE state='firing';
CREATE INDEX IF NOT EXISTS alerts_recent ON alerts(started_at DESC);
`;
