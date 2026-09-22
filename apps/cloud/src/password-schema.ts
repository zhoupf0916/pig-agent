export const passwordAccountSchema = `
 CREATE TABLE IF NOT EXISTS password_accounts(username text PRIMARY KEY, owner_id text NOT NULL UNIQUE REFERENCES principals(id), password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS registration_requests(id text PRIMARY KEY,username text NOT NULL UNIQUE,name text NOT NULL,reason text NOT NULL DEFAULT '',password_hash text,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),owner_id text REFERENCES principals(id),reviewed_by text REFERENCES principals(id),review_note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz);
 CREATE INDEX IF NOT EXISTS registration_pending ON registration_requests(created_at) WHERE state='pending';
`;
