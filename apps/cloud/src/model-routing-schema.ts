// Migration 0005: standby model channels and a per-channel output cap (expand-only).
// `enabled` stays the single primary channel (unique index kept, so older code is unaffected);
// channels with a fallback_rank are tried in rank order when the primary fails.
export const modelRoutingSchemaSql = `
ALTER TABLE model_channels ADD COLUMN IF NOT EXISTS fallback_rank int CHECK (fallback_rank BETWEEN 1 AND 9);
ALTER TABLE model_channels ADD COLUMN IF NOT EXISTS max_output_tokens int NOT NULL DEFAULT 4096 CHECK (max_output_tokens BETWEEN 256 AND 32768);
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS settle_kind text CHECK (settle_kind IN ('usage','estimated'));
`;
