/** Per-IP / per-account auth throttling windows; legacy global-bucket rows are dropped. */
export const authRateLimitSchema = `
CREATE TABLE IF NOT EXISTS auth_rate_limits(bucket text PRIMARY KEY, window_id bigint NOT NULL, count int NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry ON auth_rate_limits(expires_at);
DELETE FROM platform_settings WHERE key='webAuthRate' OR key LIKE 'passwordAuth:%';
`;
