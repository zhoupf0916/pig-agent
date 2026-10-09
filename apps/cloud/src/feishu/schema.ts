// Migration 0010 (expand-only): Feishu bot bindings, one-time bind codes, chat → conversation map,
// event de-duplication and durable pending replies (survive a cloud restart).
export const feishuSchemaSql = `
CREATE TABLE IF NOT EXISTS feishu_bindings(
  open_id text PRIMARY KEY,
  principal_id text NOT NULL UNIQUE REFERENCES principals(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feishu_bind_codes(
  code_hash text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS feishu_bind_codes_owner ON feishu_bind_codes(principal_id);
CREATE TABLE IF NOT EXISTS feishu_chats(
  chat_key text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  last_run_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feishu_messages(
  message_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feishu_replies(
  message_id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  approval_notified boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feishu_replies_open ON feishu_replies(created_at) WHERE done_at IS NULL;
`;
