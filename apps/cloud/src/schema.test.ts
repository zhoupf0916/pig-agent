import { describe, expect, it } from "vitest";
import { checksum } from "./migrations.ts";
import { migrations } from "./schema.ts";

describe("shipped migrations", () => {
  it("are append-only: the baseline checksum is frozen", () => {
    // If this fails you edited the baseline (or a *Schema constant it composes). Revert that and
    // add a new migration to migrations() in schema.ts instead.
    expect(migrations()[0]!.name).toBe("baseline");
    expect(checksum(migrations()[0]!.sql)).toBe("87c2a75553197f9b8cdc38b1cbd4dab79e8d0711fa4205b417ff711fde375a57");
  });
});

describe("migration list", () => {
  it("has increasing versions and unique names", () => {
    const list = migrations();
    expect(list.map((m) => m.version)).toEqual([...list.map((m) => m.version)].sort((a, b) => a - b));
    expect(new Set(list.map((m) => m.name)).size).toBe(list.length);
  });
});
