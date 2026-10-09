import { describe, expect, it } from "vitest";
import { checksum, MIGRATION_LOCK, planMigrations, runMigrations, type Migration } from "./migrations.ts";

type Row = { version: number; name: string; checksum: string; applied_at: Date };

function fakeDb(rows: Row[] = [], failOn?: string) {
  const log: string[] = [];
  let tx: Row[] | undefined;
  let table = rows.length > 0;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (failOn && sql === failOn) throw new Error("boom");
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) table = true;
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ ok: table }] };
      if (sql.startsWith("SELECT version")) return { rows: [...rows] };
      if (sql === "BEGIN") tx = [];
      if (sql === "COMMIT") (rows.push(...(tx ?? [])), (tx = undefined));
      if (sql === "ROLLBACK") tx = undefined;
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        const row = { version: params[0] as number, name: params[1] as string, checksum: params[2] as string, applied_at: new Date() };
        if (tx) tx.push(row);
        else rows.push(row);
      }
      return { rows: [] };
    },
  };
  return { client: client as any, rows, log };
}

const m = (version: number, sql = `SELECT ${version}`, extra: Partial<Migration> = {}): Migration => ({ version, name: `m${version}`, sql, ...extra });

describe("versioned migrations", () => {
  it("applies pending versions in order, each with its record in one transaction, under the advisory lock", async () => {
    const { client, rows, log } = fakeDb();
    const plan = await runMigrations(client, [m(1), m(2)], () => {});
    expect(plan.pending.map((p) => p.version)).toEqual([1, 2]);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(log[0]).toBe("SELECT pg_advisory_lock($1)");
    expect(log.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(2);
    expect(MIGRATION_LOCK).toBe(71839021);
  });

  it("is a no-op once everything is applied", async () => {
    const { client, log } = fakeDb([{ version: 1, name: "m1", checksum: checksum("SELECT 1"), applied_at: new Date() }]);
    const plan = await runMigrations(client, [m(1)], () => {});
    expect(plan.pending).toEqual([]);
    expect(log).not.toContain("BEGIN");
  });

  it("refuses to run when an applied migration was edited", async () => {
    const { client } = fakeDb([{ version: 1, name: "m1", checksum: checksum("SELECT 'old'"), applied_at: new Date() }]);
    await expect(runMigrations(client, [m(1)], () => {})).rejects.toThrow(/changed after it was applied/);
  });

  it("stops at a failing migration, keeping earlier versions and releasing the lock", async () => {
    const { client, rows, log } = fakeDb([], "SELECT broken");
    await expect(runMigrations(client, [m(1), m(2, "SELECT broken"), m(3)], () => {})).rejects.toThrow("boom");
    expect(rows.map((r) => r.version)).toEqual([1]);
    expect(log).toContain("ROLLBACK");
    expect(log.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
  });

  it("runs non-transactional migrations outside BEGIN/COMMIT", async () => {
    const { client, rows, log } = fakeDb();
    await runMigrations(client, [m(1, "CREATE INDEX CONCURRENTLY x ON t(a)", { transaction: false })], () => {});
    expect(log).not.toContain("BEGIN");
    expect(rows.map((r) => r.version)).toEqual([1]);
  });

  it("tolerates a database that is ahead of this build (application rollback)", async () => {
    const lines: string[] = [];
    const { client } = fakeDb([
      { version: 1, name: "m1", checksum: checksum("SELECT 1"), applied_at: new Date() },
      { version: 2, name: "future", checksum: "x", applied_at: new Date() },
    ]);
    const plan = await runMigrations(client, [m(1)], (line) => lines.push(line));
    expect(plan.unknown).toEqual([2]);
    expect(lines.join()).toMatch(/newer migrations \(2\)/);
  });

  it("status on a database without schema_migrations reports everything pending without writing", async () => {
    const { client, log } = fakeDb();
    const plan = await planMigrations(client, [m(1)]);
    expect(plan.pending).toHaveLength(1);
    expect(log.some((l) => /^(CREATE|INSERT|BEGIN)/.test(l))).toBe(false);
  });

  it("rejects non-increasing versions", async () => {
    await expect(planMigrations(fakeDb().client, [m(2), m(1)])).rejects.toThrow(/increasing/);
  });
});

