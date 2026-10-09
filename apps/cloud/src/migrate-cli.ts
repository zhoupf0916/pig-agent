// Usage (inside the cloud image): node migrate.mjs [status|up]
//   status (default): read-only; prints applied and pending versions, exits 0.
//   up: applies pending migrations (the cloud service also does this on start).
import pg from "pg";
import { planMigrations, runMigrations } from "./migrations.ts";
import { migrations } from "./schema.ts";

const command = process.argv[2] ?? "status";
if (!["status", "up"].includes(command)) {
  console.error("Usage: node migrate.mjs [status|up]");
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  if (command === "up") await runMigrations(client, migrations());
  const plan = await planMigrations(client, migrations());
  for (const row of plan.applied)
    console.log(`applied  ${String(row.version).padStart(4, "0")} ${row.name}  ${row.appliedAt.toISOString()}`);
  for (const migration of plan.pending)
    console.log(`pending  ${String(migration.version).padStart(4, "0")} ${migration.name}${migration.transaction === false ? "  (non-transactional)" : ""}`);
  for (const version of plan.unknown)
    console.log(`newer    ${String(version).padStart(4, "0")} (not in this build; expand-only, safe to run)`);
  console.log(`${plan.pending.length} pending, ${plan.applied.length} applied`);
} finally {
  await client.end();
}
