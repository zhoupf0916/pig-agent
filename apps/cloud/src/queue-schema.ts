// Migration 0008: queue retries, dead letters and owner-first claim indexes (expand-only).
// New columns default to "no retry state", so older control planes keep working unchanged.
export const queueSchemaSql = `
ALTER TABLE runs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_error_class text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS replayed_as text;
-- Owner-first claim: distinct owners with queued runs (loose index scan) and their oldest run.
CREATE INDEX IF NOT EXISTS runs_queued_owner ON runs(owner_id, created_at, id) WHERE state='queued';
-- Concurrency checks count only active runs.
CREATE INDEX IF NOT EXISTS runs_active_owner ON runs(owner_id) WHERE state IN ('preparing','running','cancelling');
CREATE INDEX IF NOT EXISTS runs_active_project ON runs(project_id) WHERE state IN ('preparing','running','cancelling') AND project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_dead_letters ON runs(dead_lettered_at DESC) WHERE dead_lettered_at IS NOT NULL AND replayed_as IS NULL;
-- Fresh statistics so the planner uses the new partial indexes right away.
ANALYZE runs;
`;
