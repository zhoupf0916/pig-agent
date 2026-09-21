import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
// Run real migration DDL against an empty, transaction-local schema. Rollback leaves the live cluster untouched.
const base = (await readFile("apps/cloud/src/db.ts", "utf8")).match(
  /await client\.query\(`([\s\S]*?)`\);/,
)?.[1];
const collaboration = (
  await readFile("apps/cloud/src/collaboration-schema.ts", "utf8")
).match(/export const collaborationSchema = `([\s\S]*?)`;/)?.[1];
const cluster = (
  await readFile("apps/cloud/src/cluster-schema.ts", "utf8")
).match(/export const clusterSchema = `([\s\S]*?)`;/)?.[1];
assert(
  base && collaboration && cluster,
  "Expected actual migration DDL templates",
);
const schema = `acceptance_migration_${Date.now()}`;
const sql = `BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; ${base} ${collaboration} ${cluster}
INSERT INTO workers(id,instance_id) VALUES('fixture','instance-one');
${cluster}
DO $$ BEGIN IF (SELECT count(*) FROM worker_generations WHERE worker_id='fixture' AND instance_id='instance-one')<>1 THEN RAISE EXCEPTION 'generation backfill missing'; END IF; END $$;
ROLLBACK;`;
execFileSync(
  "docker",
  [
    "compose",
    "--env-file",
    "data/cluster-local/stack.env",
    "-f",
    "infra/cluster/compose.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "pig",
    "-d",
    "pig",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
  ],
  { input: sql, stdio: ["pipe", "pipe", "pipe"] },
);
console.log(
  "PASS fresh PostgreSQL migration, repeated migration, existing generation backfill; isolated schema rolled back",
);
