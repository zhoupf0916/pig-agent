import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  MAX_ATTEMPTS,
  WebhookDispatcher,
  backoffMs,
  newWebhookSecret,
  registerWebhookSink,
  signPayload,
  validateWebhookUrl,
  verifySignature,
  webhookCreateSchema,
  webhookUpdateSchema,
} from "./webhooks.ts";
import { encryptSecret } from "./platform.ts";
import type { CloudEnv } from "./types.ts";

process.env.ENCRYPTION_KEY ||= "11".repeat(32);

describe("webhook signatures", () => {
  const secret = newWebhookSecret();
  const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
  it("round-trips and has the documented format", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(verifySignature(secret, header, body, 1_700_000_100)).toEqual({ ok: true, timestamp: 1_700_000_000 });
  });
  it("rejects tampering, wrong secrets, stale timestamps and malformed headers", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(verifySignature(secret, header, body + " ", 1_700_000_000)).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verifySignature(newWebhookSecret(), header, body, 1_700_000_000)).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verifySignature(secret, header, body, 1_700_000_301)).toMatchObject({ ok: false, reason: "stale" });
    expect(verifySignature(secret, header.replace("t=1700000000", "t=1700000001"), body, 1_700_000_000)).toMatchObject({ ok: false });
    for (const bad of [undefined, "", "v1=abc", "t=x,v1=" + "0".repeat(64), "t=1,v1=zz"])
      expect(verifySignature(secret, bad, body, 1).ok).toBe(false);
  });
  it("generates distinct high-entropy secrets", () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(newWebhookSecret());
  });
});

describe("retry backoff", () => {
  it("doubles from 30 s with ±20 % jitter and caps at 1 h", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, undefined, mid) / 1000)).toEqual([30, 60, 120, 240, 480, 960, 1920]);
    expect(backoffMs(1, undefined, () => 0)).toBe(24_000);
    expect(backoffMs(1, undefined, () => 1)).toBe(36_000);
    expect(backoffMs(30, undefined, mid)).toBe(3_600_000);
  });
  it("honours Retry-After (bounded)", () => {
    expect(backoffMs(1, 5)).toBe(5000);
    expect(backoffMs(1, 99_999)).toBe(3_600_000);
    expect(backoffMs(1, 0, () => 0.5)).toBe(30_000);
  });
});

describe("webhook validation", () => {
  const resolvePublic = async () => ["93.184.216.34"];
  it("accepts only known events and strict bodies", () => {
    expect(webhookCreateSchema.safeParse({ url: "https://example.com/h", events: ["run.succeeded"] }).success).toBe(true);
    expect(webhookCreateSchema.safeParse({ url: "https://example.com/h", events: [] }).success).toBe(false);
    expect(webhookCreateSchema.safeParse({ url: "https://example.com/h", events: ["run.started"] }).success).toBe(false);
    expect(webhookCreateSchema.safeParse({ url: "https://example.com/h", events: ["run.failed"], secret: "x" }).success).toBe(false);
    expect(webhookUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
  });
  it("allows public HTTPS 443 and blocks SSRF targets", async () => {
    await expect(validateWebhookUrl("https://example.com/hook?a=1", resolvePublic)).resolves.toBe("https://example.com/hook?a=1");
    for (const bad of [
      "http://example.com/h",
      "https://example.com:8443/h",
      "https://user:pw@example.com/h",
      "https://localhost/h",
      "https://10.0.0.5/h",
      "https://169.254.169.254/latest",
      "https://svc.internal/h",
      "not a url",
    ])
      await expect(validateWebhookUrl(bad, resolvePublic), bad).rejects.toThrow();
    await expect(
      validateWebhookUrl("https://rebind.example/h", async () => {
        throw Error("域名解析包含非公网地址");
      }),
    ).rejects.toThrow(/公网/);
  });
});

/** In-memory stand-in for the two dispatcher statements, enough to test claim/finish bookkeeping. */
function fakeDb(rows: any[]) {
  const updates: any[][] = [];
  return {
    updates,
    db: {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("WITH due")) {
          const claimed = rows.splice(0, Number(params[0])).map((r) => ({ ...r, attempts: r.attempts + 1 }));
          return { rows: claimed, rowCount: claimed.length };
        }
        updates.push([sql.includes("'succeeded'") ? "succeeded" : params[1], ...params]);
        return { rows: [], rowCount: 1 };
      },
    },
  };
}
const row = (attempts = 0, extra = {}) => ({
  id: "whd_1",
  event: "run.succeeded",
  event_id: "evt_x",
  payload: { id: "evt_x", type: "run.succeeded", data: {} },
  attempts,
  webhook_id: "wh_" + "a".repeat(32),
  url: "https://example.com/h",
  secret: encryptSecret("whsec_test"),
  enabled: true,
  ...extra,
});

describe("webhook dispatcher", () => {
  it("signs each delivery with the decrypted secret and records success", async () => {
    const { db, updates } = fakeDb([row()]);
    const seen: Array<Record<string, string>> = [];
    const d = new WebhookDispatcher({
      db,
      send: async (_url, headers, body) => {
        seen.push(headers);
        expect(verifySignature("whsec_test", headers["X-Pig-Signature"], body).ok).toBe(true);
        return { status: 204 };
      },
    });
    expect(await d.tick()).toBe(1);
    expect(seen[0]).toMatchObject({ "X-Pig-Event": "run.succeeded", "X-Pig-Event-Id": "evt_x", "X-Pig-Delivery": "whd_1" });
    expect(updates[0]![0]).toBe("succeeded");
    expect(d.stats).toEqual({ delivered: 1, failed: 0, dead: 0 });
  });
  it("schedules a retry on failure and gives up after the last attempt", async () => {
    const { db, updates } = fakeDb([row(0), row(MAX_ATTEMPTS - 1, { id: "whd_2" })]);
    const d = new WebhookDispatcher({ db, send: async () => ({ status: 503, error: "HTTP 503" }) });
    await d.tick();
    const byId = Object.fromEntries(updates.map((u) => [u[1], u]));
    expect(byId.whd_1![0]).toBe("pending");
    expect(byId.whd_1![5]).toBeGreaterThanOrEqual(24);
    expect(byId.whd_2![0]).toBe("dead");
    expect(d.stats).toMatchObject({ failed: 1, dead: 1 });
  });
  it("treats thrown transport errors as failed attempts", async () => {
    const { db, updates } = fakeDb([row()]);
    const d = new WebhookDispatcher({ db, send: async () => { throw Error("ECONNREFUSED"); } });
    await d.tick();
    expect(updates[0]![0]).toBe("pending");
    expect(updates[0]![4]).toBe("ECONNREFUSED");
  });
  it("does not deliver for a disabled webhook", async () => {
    const { db, updates } = fakeDb([row(0, { enabled: false })]);
    let sent = 0;
    await new WebhookDispatcher({ db, send: async () => (sent++, { status: 200 }) }).tick();
    expect(sent).toBe(0);
    expect(updates[0]![0]).toBe("dead");
  });
});

describe("self-test sink", () => {
  const id = "wh_" + "b".repeat(32);
  const secret = "whsec_sink";
  const app = new Hono<CloudEnv>();
  registerWebhookSink(app, async (x) => (x === id ? encryptSecret(secret) : undefined));
  const post = (headers: Record<string, string>, body: string) =>
    app.request("/v1/webhook-sink", { method: "POST", headers, body });
  it("accepts only correctly signed deliveries of a known webhook", async () => {
    const body = '{"id":"evt_s","type":"ping"}';
    expect((await post({ "X-Pig-Webhook-Id": id, "X-Pig-Signature": signPayload(secret, body) }, body)).status).toBe(204);
    expect((await post({ "X-Pig-Webhook-Id": id, "X-Pig-Signature": signPayload("whsec_other", body) }, body)).status).toBe(401);
    expect((await post({ "X-Pig-Webhook-Id": "wh_" + "c".repeat(32), "X-Pig-Signature": signPayload(secret, body) }, body)).status).toBe(401);
    expect((await post({ "X-Pig-Webhook-Id": "nope" }, body)).status).toBe(400);
    expect((await post({ "X-Pig-Webhook-Id": id, "X-Pig-Signature": signPayload(secret, body, 1) }, body)).status).toBe(401);
  });
});
