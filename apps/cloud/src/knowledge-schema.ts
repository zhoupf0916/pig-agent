// Migration 0007: project knowledge base (expand-only). Originals follow STORAGE_MODE like attachments;
// chunks carry a `simple` tsvector of app-tokenized terms (Han bigrams) and an optional normalized embedding.
export const knowledgeSchemaSql = `
CREATE TABLE IF NOT EXISTS knowledge_documents(
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES principals(id),
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  data bytea,
  blob_key text,
  blob_sha256 text,
  blob_verified_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error text,
  warning text,
  attempts integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  char_count integer NOT NULL DEFAULT 0,
  embedded_chunks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_documents_project ON knowledge_documents(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_dedupe ON knowledge_documents(project_id, sha256);
CREATE INDEX IF NOT EXISTS knowledge_documents_queue ON knowledge_documents(updated_at) WHERE status IN ('pending','processing');
CREATE TABLE IF NOT EXISTS knowledge_chunks(
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  ordinal integer NOT NULL,
  heading text NOT NULL DEFAULT '',
  content text NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  token_count integer NOT NULL,
  terms tsvector NOT NULL,
  embedding real[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_terms ON knowledge_chunks USING gin(terms);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id, ordinal);
CREATE INDEX IF NOT EXISTS knowledge_chunks_project ON knowledge_chunks(project_id);
`;
