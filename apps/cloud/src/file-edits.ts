import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { decideFileEdit, workspaceEditPathError, workspaceFileRevision } from "@pig-agent/contracts";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";

export const fileEditSchema = `
CREATE TABLE IF NOT EXISTS workspace_file_edits (
  conversation_id text NOT NULL,
  path text NOT NULL,
  content text NOT NULL,
  revision text NOT NULL,
  author_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, path)
);
CREATE TABLE IF NOT EXISTS workspace_file_edit_versions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  path text NOT NULL,
  content text NOT NULL,
  revision text NOT NULL,
  author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

type QueryClient = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

export function newerFileOverrides(
  edits: Array<{ path: string; content: string; updatedAt: string }>,
  checkpointAt?: string | null,
) {
  if (!checkpointAt) return edits.map(({ path, content }) => ({ path, content }));
  const checkpoint = Date.parse(checkpointAt);
  return edits
    .filter((edit) => Date.parse(edit.updatedAt) > checkpoint)
    .map(({ path, content }) => ({ path, content }));
}

export async function loadFileOverrides(
  conversationId: string,
  client: QueryClient = db,
  checkpointAt?: string | null,
) {
  const rows = await client.query(
    "SELECT path, content, updated_at FROM workspace_file_edits WHERE conversation_id=$1 ORDER BY path",
    [conversationId],
  );
  return newerFileOverrides(
    rows.rows.map((row: { path: string; content: string; updated_at: string | Date }) => ({
      path: row.path,
      content: row.content,
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    checkpointAt,
  );
}

type CurrentFile =
  | { content: string; revision: string; authorId: string | null; prior: "edit" | "artifact" }
  | { missing: true };

/** Latest checkpoint wins over an older human draft. A path absent from that checkpoint stays deleted. */
export async function currentConversationFile(
  client: QueryClient,
  conversationId: string,
  path: string,
): Promise<CurrentFile> {
  const edit = (await client.query(
    "SELECT content, revision, author_id, updated_at FROM workspace_file_edits WHERE conversation_id=$1 AND path=$2 FOR UPDATE",
    [conversationId, path],
  )).rows[0] as { content: string; revision: string; author_id: string; updated_at: string | Date } | undefined;
  const checkpoint = (await client.query(
    "SELECT run_id, created_at, snapshot->'files' AS files FROM workspace_versions WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",
    [conversationId],
  )).rows[0] as { run_id: string; created_at: string | Date; files: string[] | null } | undefined;
  const editIsCurrent = Boolean(
    edit && (!checkpoint || new Date(edit.updated_at).getTime() > new Date(checkpoint.created_at).getTime()),
  );
  if (editIsCurrent && edit) {
    return { content: edit.content, revision: edit.revision, authorId: edit.author_id, prior: "edit" };
  }
  if (checkpoint) {
    const files = Array.isArray(checkpoint.files) ? checkpoint.files : [];
    if (!files.includes(path)) return { missing: true };
    const artifact = (await client.query(
      "SELECT content FROM artifacts WHERE run_id=$1 AND path=$2",
      [checkpoint.run_id, path],
    )).rows[0] as { content: string } | undefined;
    if (!artifact) return { missing: true };
    return { content: artifact.content, revision: workspaceFileRevision(artifact.content), authorId: null, prior: "artifact" };
  }
  if (edit) return { content: edit.content, revision: edit.revision, authorId: edit.author_id, prior: "edit" };
  const latestRun = (await client.query(
    "SELECT id FROM runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",
    [conversationId],
  )).rows[0] as { id: string } | undefined;
  const artifact = (await client.query(
    "SELECT a.content, r.id AS run_id FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.conversation_id=$1 AND a.path=$2 ORDER BY r.created_at DESC LIMIT 1",
    [conversationId, path],
  )).rows[0] as { content: string; run_id: string } | undefined;
  if (!artifact || (latestRun && artifact.run_id !== latestRun.id)) return { missing: true };
  return { content: artifact.content, revision: workspaceFileRevision(artifact.content), authorId: null, prior: "artifact" };
}

export async function applyConversationFileEdit(
  client: QueryClient,
  input: { conversationId: string; actorId: string; path: string; content: string; baseRevision: string },
): Promise<{ path: string; revision: string; authorId: string } | { error: string; status: 400 | 403 | 404 | 409 }> {
  const pathError = workspaceEditPathError(input.path);
  if (pathError) return { error: pathError, status: 400 };
  if (utf8Bytes(input.content) > 200_000) return { error: "文件过大，不能在工作台编辑", status: 400 };
  await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [input.actorId]);
  const conversation = (await client.query(
    `SELECT id, CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,true) END AS can_write
     FROM conversations WHERE id=$1 FOR UPDATE`,
    [input.conversationId, input.actorId],
  )).rows[0] as { id: string; can_write: boolean } | undefined;
  if (!conversation) return { error: "会话不存在", status: 404 };
  if (!conversation.can_write) return { error: "当前权限不能编辑该文件", status: 403 };
  const busy = Number((await client.query(
    "SELECT count(*) FROM runs WHERE conversation_id=$1 AND state IN ('queued','preparing','running','cancelling')",
    [conversation.id],
  )).rows[0].count) > 0;
  const current = await currentConversationFile(client, conversation.id, input.path);
  if ("missing" in current) return { error: "文件不存在", status: 404 };
  const decision = decideFileEdit({
    canWrite: true,
    workspaceBusy: busy,
    baseRevision: input.baseRevision,
    currentRevision: current.revision,
  });
  if (decision === "busy") return { error: "任务正在使用该工作区，不能写入", status: 409 };
  if (decision === "conflict") return { error: "文件已变化，请重新打开后再保存", status: 409 };
  await client.query(
    "INSERT INTO workspace_file_edit_versions(id,conversation_id,path,content,revision,author_id) VALUES($1,$2,$3,$4,$5,$6)",
    [`fev_${randomUUID().replaceAll("-", "")}`, conversation.id, input.path, current.content, current.revision, current.authorId ?? input.actorId],
  );
  const revision = workspaceFileRevision(input.content);
  await client.query(
    `INSERT INTO workspace_file_edits(conversation_id,path,content,revision,author_id)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (conversation_id, path) DO UPDATE SET content=$3, revision=$4, author_id=$5, updated_at=now()`,
    [conversation.id, input.path, input.content, revision, input.actorId],
  );
  return { path: input.path, revision, authorId: input.actorId };
}

export async function readConversationFile(client: QueryClient, conversationId: string, path: string) {
  const pathError = workspaceEditPathError(path);
  if (pathError) return { error: pathError, status: 400 as const };
  const current = await currentConversationFile(client, conversationId, path);
  if ("missing" in current) return { error: "文件不存在", status: 404 as const };
  return { path, content: current.content, revision: current.revision, source: current.prior };
}

export function registerFileEditRoutes(app: Hono<CloudEnv>): void {
  app.get("/v1/conversations/:id/file", async (c) => {
    const path = c.req.query("path") || "";
    const pathError = workspaceEditPathError(path);
    if (pathError) return c.json({ error: pathError }, 400);
    const conversation = (await db.query(
      `SELECT id, CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,false) END AS can_read
       FROM conversations WHERE id=$1`,
      [c.req.param("id"), c.get("principal").id],
    )).rows[0];
    if (!conversation?.can_read && c.get("principal").role !== "admin") return c.json({ error: "会话不存在" }, 404);
    const file = await readConversationFile(db, c.req.param("id"), path);
    if ("error" in file) return c.json({ error: file.error }, file.status);
    return c.json(file);
  });

  app.put("/v1/conversations/:id/file", async (c) => {
    const body = await c.req.json().catch(() => null) as { path?: string; content?: string; baseRevision?: string } | null;
    if (!body?.path || typeof body.content !== "string" || typeof body.baseRevision !== "string") {
      return c.json({ error: "请提供文件路径、内容和打开时的版本" }, 400);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyConversationFileEdit(client, {
        conversationId: c.req.param("id"),
        actorId: c.get("principal").id,
        path: body.path,
        content: body.content,
        baseRevision: body.baseRevision,
      });
      if ("error" in result) {
        await client.query("ROLLBACK");
        return c.json({ error: result.error }, result.status);
      }
      await client.query("COMMIT");
      return c.json(result);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
