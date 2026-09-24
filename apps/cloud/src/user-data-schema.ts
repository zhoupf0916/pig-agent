export const userDataSchema = `
 CREATE TABLE IF NOT EXISTS user_settings(owner_id text PRIMARY KEY REFERENCES principals(id),value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS user_memories(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS stability text NOT NULL DEFAULT 'stable';
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;
 ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
 CREATE INDEX IF NOT EXISTS user_memories_owner ON user_memories(owner_id,created_at);
`;
