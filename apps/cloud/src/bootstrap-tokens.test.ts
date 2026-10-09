import { describe, expect, it } from "vitest";
import {
  STATIC_TOKEN_LIVE,
  bootstrapTtlHours,
  syncBootstrapPrincipals,
} from "./bootstrap-tokens.ts";

function fakeClient(rowCount = 1) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rowCount };
    },
  };
}

describe("bootstrap bearer tokens", () => {
  it("parses the TTL strictly", () => {
    expect(bootstrapTtlHours({})).toBeNull();
    expect(bootstrapTtlHours({ BOOTSTRAP_TOKEN_TTL_HOURS: " " })).toBeNull();
    expect(bootstrapTtlHours({ BOOTSTRAP_TOKEN_TTL_HOURS: "24" })).toBe(24);
    for (const bad of ["0", "-1", "1.5", "abc", "8761"])
      expect(() => bootstrapTtlHours({ BOOTSTRAP_TOKEN_TTL_HOURS: bad })).toThrow();
  });

  it("requires the admin bootstrap credential", async () => {
    await expect(syncBootstrapPrincipals(fakeClient(), {})).rejects.toThrow(
      "Missing bootstrap credential",
    );
  });

  it("upserts configured tokens with an expiry window and never stores the raw token", async () => {
    const client = fakeClient();
    const summary = await syncBootstrapPrincipals(client, {
      ADMIN_TOKEN: "admin-secret-value",
      MEMBER_TOKEN: "member-secret-value",
      MEMBER2_TOKEN: "member2-secret-value",
      BOOTSTRAP_TOKEN_TTL_HOURS: "24",
    });
    expect(summary).toEqual({ admin: "active", member: "active", member2: "active" });
    const upserts = client.calls.filter((c) => c.sql.includes("INSERT INTO principals"));
    expect(upserts).toHaveLength(3);
    for (const u of upserts) {
      expect(u.values?.[4]).toBe(24);
      expect(String(u.values?.[3])).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(u.values)).not.toContain("secret-value");
      // Same token keeps its window/revocation; a rotated token clears revocation.
      expect(u.sql).toContain("WHEN principals.token_hash=$4 THEN principals.token_revoked_at ELSE NULL");
    }
  });

  it("revokes unset optional tokens and disables the member2 test account", async () => {
    const client = fakeClient();
    const summary = await syncBootstrapPrincipals(client, { ADMIN_TOKEN: "admin-secret-value", MEMBER2_TOKEN: "" });
    expect(summary).toEqual({ admin: "active", member: "revoked", member2: "revoked" });
    const updates = client.calls.filter((c) => c.sql.startsWith("UPDATE principals"));
    expect(updates.map((u) => u.values?.[0])).toEqual(["member", "member2"]);
    expect(updates[0]!.sql).not.toContain("enabled=false");
    expect(updates[1]!.sql).toContain("enabled=false");
    expect(client.calls.filter((c) => c.sql.includes("INSERT INTO audit"))).toHaveLength(2);
  });

  it("does not audit when nothing changed", async () => {
    const client = fakeClient(0);
    const summary = await syncBootstrapPrincipals(client, { ADMIN_TOKEN: "x".repeat(20) });
    expect(summary.member).toBe("absent");
    expect(client.calls.some((c) => c.sql.includes("audit"))).toBe(false);
  });

  it("exposes a liveness predicate for static tokens", () => {
    expect(STATIC_TOKEN_LIVE).toContain("token_revoked_at IS NULL");
    expect(STATIC_TOKEN_LIVE).toContain("token_expires_at>now()");
  });
});
