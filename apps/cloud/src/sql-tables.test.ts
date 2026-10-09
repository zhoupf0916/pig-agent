import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Static guard: every table that SQL in the cloud service reads or writes must be created by a schema/migration
// in this package. Unit tests mock `db.query`, so a wrong table name (e.g. "projects" instead of
// "shared_projects") would otherwise only surface as a 500 in production.
const dir = new URL(".", import.meta.url);
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(new URL(file, dir), "utf8") }));

function declared() {
  const names = new Set<string>();
  const patterns = [
    /CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi,
    /CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi,
    /(?:NEW|OLD) TABLE AS ([a-z_][a-z0-9_]*)/gi,
    /(?:WITH|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*(?:MATERIALIZED\s*)?\(/gi,
  ];
  for (const { text } of sources)
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) names.add(match[1]!.toLowerCase());
  return names;
}

function referencedTables(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(?:FROM|JOIN|UPDATE|INSERT INTO|DELETE FROM)\s+([a-z_][a-z0-9_]*)\b(?!\s*\()/g))
    found.push(match[1]!);
  return found;
}

describe("SQL table references", () => {
  it("only references tables that the schema creates", () => {
    const known = declared();
    expect(known.has("shared_projects")).toBe(true);
    const unknown = sources.flatMap(({ file, text }) =>
      referencedTables(text)
        .filter((table) => !known.has(table))
        .map((table) => `${file}: ${table}`),
    );
    expect([...new Set(unknown)]).toEqual([]);
  });
  it("flags a query against a table that does not exist", () => {
    expect(referencedTables("SELECT space_id FROM projects WHERE id=$1")).toEqual(["projects"]);
    expect(declared().has("projects")).toBe(false);
  });
});
