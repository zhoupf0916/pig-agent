export const userDataSchema = `
 CREATE TABLE IF NOT EXISTS user_settings(owner_id text PRIMARY KEY REFERENCES principals(id),value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS user_memories(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS user_memories_owner ON user_memories(owner_id,created_at);
`;
