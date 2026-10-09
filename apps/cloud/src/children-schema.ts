// Migration 0009: parallel subtasks (expand-only). A parent run that calls spawn_parallel yields its
// Runner slot (state 'waiting'); its children are ordinary queued runs linked through run_children.
export const childrenSchemaSql = `
ALTER TABLE runs ADD COLUMN IF NOT EXISTS resumed_at timestamptz;
CREATE TABLE IF NOT EXISTS run_child_groups(
  parent_run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  instruction text NOT NULL,
  output_schema jsonb,
  max_parallel integer NOT NULL CHECK (max_parallel BETWEEN 1 AND 5),
  max_model_calls integer NOT NULL CHECK (max_model_calls BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  summary text,
  PRIMARY KEY(parent_run_id, call_id)
);
CREATE INDEX IF NOT EXISTS run_child_groups_open ON run_child_groups(created_at) WHERE state='running';
CREATE TABLE IF NOT EXISTS run_children(
  parent_run_id text NOT NULL,
  call_id text NOT NULL,
  idx integer NOT NULL,
  item text NOT NULL,
  child_run_id text REFERENCES runs(id),
  attempts integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
  output jsonb,
  output_text text,
  error text,
  model_calls integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(parent_run_id, call_id, idx),
  FOREIGN KEY(parent_run_id, call_id) REFERENCES run_child_groups(parent_run_id, call_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS run_children_child ON run_children(child_run_id) WHERE child_run_id IS NOT NULL;
`;
