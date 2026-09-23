export const mcpServerSchema = `
CREATE TABLE IF NOT EXISTS mcp_servers(
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES principals(id),
  name text NOT NULL,
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  timeout_ms integer NOT NULL DEFAULT 15000,
  secret text,
  credential_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_servers_owner ON mcp_servers(owner_id);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS mcp_target jsonb;
CREATE TABLE IF NOT EXISTS mcp_invocations(
  approval_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
