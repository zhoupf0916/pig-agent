/** additive schema; private runs keep their original ownership boundary */
export const collaborationSchema = `
CREATE TABLE IF NOT EXISTS spaces(id text PRIMARY KEY,name text NOT NULL,owner_id text NOT NULL REFERENCES principals(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS space_members(space_id text NOT NULL REFERENCES spaces(id),principal_id text NOT NULL REFERENCES principals(id),role text NOT NULL CHECK(role IN ('viewer','editor','admin')),PRIMARY KEY(space_id,principal_id));
CREATE TABLE IF NOT EXISTS space_invitations(token_hash text PRIMARY KEY,space_id text NOT NULL REFERENCES spaces(id),role text NOT NULL CHECK(role IN ('viewer','editor','admin')),created_by text NOT NULL REFERENCES principals(id),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS shared_projects(id text PRIMARY KEY,space_id text NOT NULL REFERENCES spaces(id),name text NOT NULL,description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE runs ADD COLUMN IF NOT EXISTS project_id text REFERENCES shared_projects(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id text REFERENCES shared_projects(id);
CREATE INDEX IF NOT EXISTS runs_shared_project ON runs(project_id,created_at);
CREATE OR REPLACE FUNCTION project_access(project text,actor text,writing boolean DEFAULT false) RETURNS boolean AS $$
SELECT EXISTS(SELECT 1 FROM shared_projects p JOIN space_members m ON m.space_id=p.space_id JOIN principals a ON a.id=m.principal_id WHERE p.id=project AND m.principal_id=actor AND a.enabled AND (NOT writing OR m.role IN ('editor','admin')));
$$ LANGUAGE SQL STABLE;
CREATE OR REPLACE FUNCTION pin_shared_project() RETURNS trigger AS $$
BEGIN
 NEW.project_id := NEW.input->>'projectId';
 IF NEW.project_id IS NOT NULL AND NOT project_access(NEW.project_id,NEW.owner_id,true) THEN RAISE EXCEPTION 'Shared project permission required' USING ERRCODE='42501'; END IF;
 IF NEW.conversation_id IS NOT NULL AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=NEW.conversation_id AND c.project_id IS DISTINCT FROM NEW.project_id) THEN RAISE EXCEPTION 'Conversation project mismatch' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pin_shared_project ON runs;
CREATE TRIGGER pin_shared_project BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION pin_shared_project();
`;
