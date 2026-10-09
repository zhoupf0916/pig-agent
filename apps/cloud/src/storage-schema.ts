// Migration 0006: object storage references (expand-only). Postgres keeps the original bytes in `dual`
// mode; blob_* columns record the verified copy in the object store.
export const storageSchemaSql = `
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS blob_key text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS blob_sha256 text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS blob_verified_at timestamptz;
ALTER TABLE attachments ALTER COLUMN data DROP NOT NULL;
ALTER TABLE workspace_versions ADD COLUMN IF NOT EXISTS blob_key text;
ALTER TABLE workspace_versions ADD COLUMN IF NOT EXISTS blob_sha256 text;
ALTER TABLE workspace_versions ADD COLUMN IF NOT EXISTS blob_size bigint;
ALTER TABLE workspace_versions ADD COLUMN IF NOT EXISTS blob_verified_at timestamptz;
CREATE INDEX IF NOT EXISTS attachments_offload_pending ON attachments(created_at) WHERE blob_key IS NULL;
CREATE INDEX IF NOT EXISTS workspace_versions_offload_pending ON workspace_versions(created_at) WHERE blob_key IS NULL;
`;
