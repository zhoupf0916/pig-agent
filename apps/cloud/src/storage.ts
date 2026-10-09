import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { db } from "./db.ts";
import { S3Client } from "./object-store.ts";
import { storageFallbacks, storageGauge, storageOps } from "./observability.ts";
import type { CloudEnv } from "./types.ts";

/**
 * Object storage for attachments and workspace snapshots.
 *
 * Modes (STORAGE_MODE, only when S3_ENDPOINT is configured):
 *  - dual (default): Postgres keeps the original bytes; after commit each blob is copied to the object
 *    store, read back and verified by SHA-256 before blob_key is recorded. Reads prefer the verified
 *    object and fall back to Postgres.
 *  - object: new blobs live only in the object store (opt-in; Postgres originals are never removed here).
 *  - pg: object store unused.
 */
export type StorageMode = "pg" | "dual" | "object";
export const storageMode = (): StorageMode =>
  !process.env.S3_ENDPOINT ? "pg" : process.env.STORAGE_MODE === "object" ? "object" : process.env.STORAGE_MODE === "pg" ? "pg" : "dual";

let client: S3Client | undefined;
export function s3(): S3Client | undefined {
  if (!process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) return undefined;
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET || "pig-agent",
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    region: process.env.S3_REGION,
  });
  return client;
}
/** For tests. */
export function setStorageClient(c: S3Client | undefined) {
  client = c;
  bucketReady = undefined;
}

export { storageFallbacks };

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const attachmentKey = (owner: string, id: string) => `attachments/${owner}/${id}`;
export const workspaceKey = (conversation: string, run: string) => `workspaces/${conversation}/${run}.tar.gz`;
export const knowledgeKey = (project: string, id: string) => `knowledge/${project}/${id}`;

let bucketReady: Promise<void> | undefined;
async function ready(c: S3Client) {
  bucketReady ??= c.ensureBucket().catch((e) => {
    bucketReady = undefined;
    throw e;
  });
  return bucketReady;
}

/** Copy-then-verify: write, read back, compare SHA-256. Returns the digest of the verified copy. */
export async function putVerified(key: string, bytes: Uint8Array, contentType?: string) {
  const c = s3();
  if (!c) throw Error("object storage not configured");
  await ready(c);
  const digest = sha256(bytes);
  try {
    await c.put(key, bytes, contentType);
    const back = await c.get(key);
    if (!back || sha256(back) !== digest) throw Error("object verification failed");
    storageOps.inc({ op: "put", result: "ok" });
    return digest;
  } catch (error) {
    storageOps.inc({ op: "put", result: "error" });
    throw error;
  }
}

/** Verified object bytes, or the Postgres copy when the object is missing, unreachable or mismatched. */
export async function readBlob(row: { blob_key?: string | null; blob_sha256?: string | null }, pgBytes: () => Buffer | undefined, kind: string) {
  const c = s3();
  if (row.blob_key && c && storageMode() !== "pg") {
    try {
      const bytes = await c.get(row.blob_key);
      if (bytes && (!row.blob_sha256 || sha256(bytes) === row.blob_sha256)) {
        storageOps.inc({ op: "get", result: "ok" });
        return bytes;
      }
      storageOps.inc({ op: "get", result: bytes ? "mismatch" : "missing" });
    } catch {
      storageOps.inc({ op: "get", result: "error" });
    }
    const fallback = pgBytes();
    if (fallback) {
      storageFallbacks.inc({ kind });
      return fallback;
    }
    throw Error("文件暂时无法读取（对象存储不可用），请稍后重试");
  }
  const bytes = pgBytes();
  if (!bytes) throw Error("文件内容缺失");
  return bytes;
}

// ---- offload (new rows after commit, backfill for existing rows) ----------------------------------

export async function offloadAttachment(id: string) {
  const row = (await db.query("SELECT id,owner_id,mime,data,blob_key FROM attachments WHERE id=$1", [id])).rows[0];
  if (!row || row.blob_key || !row.data) return false;
  const key = attachmentKey(row.owner_id, row.id);
  const digest = await putVerified(key, row.data, row.mime);
  if (sha256(row.data) !== digest) throw Error("digest mismatch");
  await db.query("UPDATE attachments SET blob_key=$2, blob_sha256=$3, blob_verified_at=now() WHERE id=$1 AND blob_key IS NULL", [id, key, digest]);
  return true;
}

export async function offloadWorkspace(runId: string) {
  const row = (await db.query("SELECT run_id,conversation_id,snapshot->>'data' AS data,blob_key FROM workspace_versions WHERE run_id=$1", [runId])).rows[0];
  if (!row || row.blob_key || !row.data) return false;
  const bytes = Buffer.from(row.data, "base64");
  const key = workspaceKey(row.conversation_id, row.run_id);
  const digest = await putVerified(key, bytes, "application/gzip");
  await db.query("UPDATE workspace_versions SET blob_key=$2, blob_sha256=$3, blob_size=$4, blob_verified_at=now() WHERE run_id=$1 AND blob_key IS NULL", [runId, key, digest, bytes.length]);
  return true;
}

export async function offloadKnowledge(id: string) {
  const row = (await db.query("SELECT id,project_id,mime,data,blob_key FROM knowledge_documents WHERE id=$1", [id])).rows[0];
  if (!row || row.blob_key || !row.data) return false;
  const key = knowledgeKey(row.project_id, row.id);
  const digest = await putVerified(key, row.data, row.mime);
  await db.query("UPDATE knowledge_documents SET blob_key=$2, blob_sha256=$3, blob_verified_at=now() WHERE id=$1 AND blob_key IS NULL", [id, key, digest]);
  return true;
}

/** Fire-and-forget offload after a commit; failures leave the row pending for the backfill sweep. */
export function offloadLater(kind: "attachment" | "workspace" | "knowledge", id: string) {
  if (storageMode() === "pg" || !s3()) return;
  void (kind === "attachment" ? offloadAttachment(id) : kind === "knowledge" ? offloadKnowledge(id) : offloadWorkspace(id)).catch(() => console.error(`Object storage offload pending: ${kind}`));
}

export async function backfill(limit = 100) {
  const result = { copied: 0, failed: 0, remaining: 0 };
  const attachments = (await db.query("SELECT id FROM attachments WHERE blob_key IS NULL AND data IS NOT NULL ORDER BY created_at LIMIT $1", [limit])).rows;
  const workspaces = (await db.query("SELECT run_id FROM workspace_versions WHERE blob_key IS NULL AND snapshot ? 'data' ORDER BY created_at LIMIT $1", [limit])).rows;
  const knowledge = (await db.query("SELECT id FROM knowledge_documents WHERE blob_key IS NULL AND data IS NOT NULL ORDER BY created_at LIMIT $1", [limit])).rows;
  for (const [fn, ids] of [[offloadAttachment, attachments.map((r) => r.id)], [offloadWorkspace, workspaces.map((r) => r.run_id)], [offloadKnowledge, knowledge.map((r) => r.id)]] as const)
    for (const id of ids) {
      try {
        if (await fn(id)) result.copied++;
      } catch {
        result.failed++;
      }
    }
  result.remaining = (await pendingCounts()).total;
  return result;
}

async function pendingCounts() {
  const r = (
    await db.query(
      `SELECT (SELECT count(*) FROM attachments WHERE blob_key IS NULL AND data IS NOT NULL)::int AS a,
              (SELECT count(*) FROM workspace_versions WHERE blob_key IS NULL AND snapshot ? 'data')::int AS w,
              (SELECT count(*) FROM knowledge_documents WHERE blob_key IS NULL AND data IS NOT NULL)::int AS k`,
    )
  ).rows[0];
  return { attachments: r.a, workspaces: r.w, knowledge: r.k, total: r.a + r.w + r.k };
}

/** Re-reads every offloaded object and compares it with the recorded digest and the Postgres original. */
export async function verifyAll(limit = 500) {
  const c = s3();
  if (!c) throw Error("object storage not configured");
  const report = { checked: 0, ok: 0, missing: [] as string[], mismatched: [] as string[] };
  const rows = [
    ...(await db.query("SELECT 'attachment' AS kind, id, blob_key, blob_sha256, data AS pg FROM attachments WHERE blob_key IS NOT NULL ORDER BY created_at LIMIT $1", [limit])).rows,
    ...(await db.query("SELECT 'workspace' AS kind, run_id AS id, blob_key, blob_sha256, decode(snapshot->>'data','base64') AS pg FROM workspace_versions WHERE blob_key IS NOT NULL ORDER BY created_at LIMIT $1", [limit])).rows,
    ...(await db.query("SELECT 'knowledge' AS kind, id, blob_key, blob_sha256, data AS pg FROM knowledge_documents WHERE blob_key IS NOT NULL ORDER BY created_at LIMIT $1", [limit])).rows,
  ];
  const TABLE: Record<string, [string, string]> = { attachment: ["attachments", "id"], workspace: ["workspace_versions", "run_id"], knowledge: ["knowledge_documents", "id"] };
  for (const row of rows) {
    report.checked++;
    const bytes = await c.get(row.blob_key);
    if (!bytes) {
      report.missing.push(`${row.kind}:${row.id}`);
      continue;
    }
    const digest = sha256(bytes);
    if (digest !== row.blob_sha256 || (row.pg && sha256(row.pg) !== digest)) {
      report.mismatched.push(`${row.kind}:${row.id}`);
      continue;
    }
    report.ok++;
    const [table, idCol] = TABLE[row.kind]!;
    await db.query(`UPDATE ${table} SET blob_verified_at=now() WHERE ${idCol}=$1`, [row.id]);
  }
  return report;
}

/** Deletes objects whose rows no longer exist (deleted attachments/conversations), after a grace period. */
export async function collectGarbage(graceMs = 24 * 3600_000, now = Date.now()) {
  const c = s3();
  if (!c || storageMode() === "pg") return { scanned: 0, deleted: 0 };
  await ready(c);
  let scanned = 0,
    deleted = 0;
  for (const [prefix, table, column] of [["attachments/", "attachments", "blob_key"], ["workspaces/", "workspace_versions", "blob_key"], ["knowledge/", "knowledge_documents", "blob_key"]] as const) {
    const batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const known = new Set((await db.query(`SELECT ${column} AS k FROM ${table} WHERE ${column}=ANY($1::text[])`, [batch])).rows.map((r) => r.k));
      // Offload writes the object before recording the key: keys missing from the DB but young are in flight.
      for (const key of batch) if (!known.has(key)) {
        await c.delete(key);
        deleted++;
        storageOps.inc({ op: "gc_delete", result: "ok" });
      }
      batch.length = 0;
    };
    for await (const o of c.list(prefix)) {
      scanned++;
      if (now - o.lastModified.getTime() < graceMs) continue;
      batch.push(o.key);
      if (batch.length >= 500) await flush();
    }
    await flush();
  }
  return { scanned, deleted };
}

export async function storageStatus() {
  const c = s3();
  let reachable: boolean | undefined;
  if (c)
    reachable = await c.request("HEAD", undefined, { timeoutMs: 3000 }).then(
      async (r) => (await r.body?.cancel(), r.status === 200),
      () => false,
    );
  const t = (
    await db.query(
      `SELECT 'attachments' AS t, count(*)::int AS total, count(blob_key)::int AS offloaded, count(blob_verified_at)::int AS verified,
              count(*) FILTER (WHERE data IS NOT NULL)::int AS in_pg, coalesce(sum(size) FILTER (WHERE blob_key IS NOT NULL),0)::bigint AS bytes FROM attachments
       UNION ALL
       SELECT 'workspaces', count(*)::int, count(blob_key)::int, count(blob_verified_at)::int,
              count(*) FILTER (WHERE snapshot ? 'data')::int, coalesce(sum(blob_size),0)::bigint FROM workspace_versions
       UNION ALL
       SELECT 'knowledge', count(*)::int, count(blob_key)::int, count(blob_verified_at)::int,
              count(*) FILTER (WHERE data IS NOT NULL)::int, coalesce(sum(size) FILTER (WHERE blob_key IS NOT NULL),0)::bigint FROM knowledge_documents`,
    )
  ).rows;
  for (const r of t) {
    storageGauge.set(r.offloaded, { table: r.t, location: "object" });
    storageGauge.set(r.in_pg, { table: r.t, location: "postgres" });
  }
  return {
    mode: storageMode(),
    configured: Boolean(c),
    bucket: c?.bucket,
    reachable,
    tables: Object.fromEntries(t.map((r) => [r.t, { total: r.total, offloaded: r.offloaded, verified: r.verified, inPostgres: r.in_pg, objectBytes: Number(r.bytes), pending: Math.max(0, r.in_pg - r.offloaded) }])),
  };
}

export function registerStorageRoutes(app: Hono<CloudEnv>) {
  const admin = (c: { get: (k: "principal") => { role: string } }) => c.get("principal")?.role === "admin";
  app.get("/v1/admin/storage", async (c) => (admin(c) ? c.json(await storageStatus()) : c.json({ error: "需要管理员权限" }, 403)));
  app.post("/v1/admin/storage/backfill", async (c) => {
    if (!admin(c)) return c.json({ error: "需要管理员权限" }, 403);
    if (storageMode() === "pg" || !s3()) return c.json({ error: "对象存储未配置" }, 409);
    const body = z.object({ limit: z.number().int().min(1).max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
    return c.json(await backfill(body.success ? body.data.limit : 100));
  });
  app.post("/v1/admin/storage/verify", async (c) => {
    if (!admin(c)) return c.json({ error: "需要管理员权限" }, 403);
    if (!s3()) return c.json({ error: "对象存储未配置" }, 409);
    return c.json(await verifyAll());
  });
}

let gcTimer: ReturnType<typeof setInterval> | undefined;
export function startStorage() {
  if (storageMode() === "pg" || !s3()) return;
  // New rows that were not offloaded (store briefly down) are retried; orphaned objects are collected.
  gcTimer ??= setInterval(() => {
    void backfill(50).catch(() => {});
    void collectGarbage().catch(() => console.error("Object storage GC unavailable"));
  }, Number(process.env.STORAGE_SWEEP_INTERVAL_MS) || 3_600_000);
  gcTimer.unref();
  void backfill(50).catch(() => console.error("Object storage backfill unavailable"));
}

/** Workspace snapshot with its tarball (`data`) present: from the verified object, else the Postgres copy. */
export async function hydrateSnapshot(row: { snapshot: any; blob_key?: string | null; blob_sha256?: string | null }) {
  const pg = typeof row.snapshot?.data === "string" ? row.snapshot.data : undefined;
  if (pg && (storageMode() !== "object" || !row.blob_key)) return row.snapshot;
  const bytes = await readBlob(row, () => (pg ? Buffer.from(pg, "base64") : undefined), "workspace");
  return { ...row.snapshot, data: bytes.toString("base64") };
}

/** Object mode: stores the tarball first (verified) and returns the row to insert without it. */
export async function prepareWorkspaceVersion(conversationId: string, runId: string, snapshot: any) {
  if (storageMode() !== "object" || !s3() || typeof snapshot?.data !== "string") return { snapshot };
  try {
    const bytes = Buffer.from(snapshot.data, "base64");
    const key = workspaceKey(conversationId, runId);
    const digest = await putVerified(key, bytes, "application/gzip");
    const { data: _data, ...manifest } = snapshot;
    return { snapshot: manifest, blob: { key, sha: digest, size: bytes.length } };
  } catch {
    return { snapshot }; // store unavailable: keep the tarball in Postgres
  }
}

/** For alerting: is the configured object store reachable, and how many rows still wait for a copy. */
export async function storageHealth() {
  const c = s3();
  if (!c || storageMode() === "pg") return { configured: false, reachable: true, pending: 0 };
  const reachable = await c.request("HEAD", undefined, { timeoutMs: 3000 }).then(
    async (r) => (await r.body?.cancel(), r.status === 200),
    () => false,
  );
  return { configured: true, reachable, pending: (await pendingCounts()).total };
}
