import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { request } from "node:https";
import type { Hono } from "hono";
import { z } from "zod";
import { db } from "./db.ts";
import { bus } from "./event-bus.ts";
import { approvedUrl, resolveNetworkAddresses } from "./network-fetch.ts";
import { decryptSecret, encryptSecret } from "./platform.ts";
import type { CloudEnv } from "./types.ts";

/**
 * Signed outbound webhooks.
 *
 * - Outbox: database triggers (migration 0003) insert one delivery per matching webhook in the same
 *   transaction as the run/approval change, so an event is never lost (at-least-once). A stable event id
 *   (`X-Pig-Event-Id`) lets receivers de-duplicate.
 * - Dispatcher: claims due deliveries with FOR UPDATE SKIP LOCKED (safe with several cloud instances),
 *   POSTs them over HTTPS to a vetted public IPv4 (no redirects), and retries with exponential backoff.
 * - Signature: `X-Pig-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 */
import { MAX_ATTEMPTS, WEBHOOK_EVENTS } from "./webhook-events.ts";
export { MAX_ATTEMPTS, WEBHOOK_EVENTS };
export const MAX_WEBHOOKS_PER_OWNER = 10;
export const SIGNATURE_TOLERANCE_S = 300;
const DELIVERY_TIMEOUT_MS = 10_000;
const LEASE_S = 60;


// ---- signing -------------------------------------------------------------------------------------

export const newWebhookSecret = () => "whsec_" + randomBytes(32).toString("base64url");

export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Reference verifier (also used by the self-test receiver). Constant-time; rejects stale timestamps. */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  nowS = Math.floor(Date.now() / 1000),
  toleranceS = SIGNATURE_TOLERANCE_S,
): { ok: true; timestamp: number } | { ok: false; reason: string } {
  const parts = Object.fromEntries(
    String(header || "").split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[a-f0-9]{64}$/.test(parts.v1 || "")) return { ok: false, reason: "malformed" };
  if (Math.abs(nowS - timestamp) > toleranceS) return { ok: false, reason: "stale" };
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1!);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true, timestamp }
    : { ok: false, reason: "mismatch" };
}

/** Delay before attempt `attempts + 1`: 30 s, 1, 2, 4, 8, 16, 32 min (±20 % jitter); Retry-After is honoured up to 1 h. */
export function backoffMs(attempts: number, retryAfterS?: number, random = Math.random) {
  if (retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0) return Math.min(retryAfterS, 3600) * 1000;
  const base = 30_000 * 2 ** Math.max(0, attempts - 1);
  return Math.round(Math.min(base, 3_600_000) * (0.8 + 0.4 * random()));
}

// ---- transport -----------------------------------------------------------------------------------

export type SendResult = { status: number; error?: string; retryAfterS?: number };
export type Send = (url: string, headers: Record<string, string>, body: string) => Promise<SendResult>;

/** POST to a vetted public HTTPS endpoint, pinned to the resolved IPv4; redirects are failures. */
export const sendHttps: Send = async (raw, headers, body) => {
  const url = approvedUrl(raw);
  const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
  const [address] = await resolveNetworkAddresses(url.hostname, signal);
  return new Promise<SendResult>((resolve) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        signal,
        family: 4,
        lookup: (_host, _options, callback) => callback(null, address!, 4),
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        const status = res.statusCode || 0;
        let snippet = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (snippet.length < 200) snippet += chunk.slice(0, 200 - snippet.length);
        });
        res.on("end", () =>
          resolve({
            status,
            retryAfterS: Number(res.headers["retry-after"]) || undefined,
            ...(status >= 200 && status < 300 ? {} : { error: `HTTP ${status}${status >= 300 && status < 400 ? " (redirects are not followed)" : ""} ${snippet}`.trim() }),
          }),
        );
        res.on("error", (e) => resolve({ status: 0, error: e.message }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, error: (e as Error).message }));
    req.end(body);
  });
};

// ---- dispatcher ----------------------------------------------------------------------------------

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export class WebhookDispatcher {
  private stopped = true;
  private loop?: Promise<void>;
  readonly stats = { delivered: 0, failed: 0, dead: 0 };
  constructor(
    private readonly opts: { db?: Queryable; send?: Send; batch?: number; maxWaitMs?: number } = {},
  ) {}
  private get pg() {
    return this.opts.db ?? db;
  }

  /** Claims and delivers one batch; returns how many deliveries were attempted. */
  async tick(): Promise<number> {
    const { rows } = await this.pg.query(
      `WITH due AS (
         SELECT id FROM webhook_deliveries
         WHERE state IN ('pending','delivering') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE webhook_deliveries d SET state='delivering', attempts=d.attempts+1, lease_until=now()+make_interval(secs=>$2), last_attempt_at=now()
       FROM due, webhooks w WHERE d.id=due.id AND w.id=d.webhook_id
       RETURNING d.id, d.event, d.event_id, d.payload, d.attempts, w.id AS webhook_id, w.url, w.secret, w.enabled`,
      [this.opts.batch ?? 10, LEASE_S],
    );
    await Promise.all(rows.map((row) => this.deliver(row)));
    return rows.length;
  }

  private async deliver(row: any) {
    if (!row.enabled) return this.finish(row, { status: 0, error: "webhook disabled" }, true);
    const body = JSON.stringify(row.payload);
    let result: SendResult;
    try {
      const secret = decryptSecret(row.secret);
      result = await (this.opts.send ?? sendHttps)(row.url, {
        "Content-Type": "application/json",
        "User-Agent": "Pig-Agent-Webhooks/1",
        "X-Pig-Event": row.event,
        "X-Pig-Event-Id": row.event_id,
        "X-Pig-Delivery": row.id,
        "X-Pig-Webhook-Id": row.webhook_id,
        "X-Pig-Signature": signPayload(secret, body),
      }, body);
    } catch (error) {
      result = { status: 0, error: (error as Error).message || "delivery failed" };
    }
    return this.finish(row, result, false);
  }

  private async finish(row: any, result: SendResult, forceDead: boolean) {
    const ok = !forceDead && result.status >= 200 && result.status < 300;
    if (ok) {
      this.stats.delivered++;
      await this.pg.query(
        "UPDATE webhook_deliveries SET state='succeeded', delivered_at=now(), last_status=$2, last_error=NULL, lease_until=NULL WHERE id=$1",
        [row.id, result.status],
      );
      return;
    }
    const dead = forceDead || row.attempts >= MAX_ATTEMPTS;
    if (dead) this.stats.dead++;
    else this.stats.failed++;
    await this.pg.query(
      `UPDATE webhook_deliveries SET state=$2, last_status=$3, last_error=$4, lease_until=NULL,
         next_attempt_at=CASE WHEN $2='pending' THEN now()+make_interval(secs=>$5::double precision) ELSE next_attempt_at END
       WHERE id=$1`,
      [row.id, dead ? "dead" : "pending", result.status || null, String(result.error || "").slice(0, 300), backoffMs(row.attempts, result.retryAfterS) / 1000],
    );
  }

  /** Milliseconds until the next due delivery (bounded), so retries fire on time without polling. */
  private async nextDueMs() {
    const { rows } = await this.pg.query(
      "SELECT ceil(extract(epoch FROM min(greatest(next_attempt_at, coalesce(lease_until, next_attempt_at))) - now()) * 1000) AS ms FROM webhook_deliveries WHERE state IN ('pending','delivering')",
    );
    const ms = rows[0]?.ms;
    const max = this.opts.maxWaitMs ?? 30_000;
    return ms === null || ms === undefined ? max : Math.max(0, Math.min(Number(ms), max));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const sub = bus.subscribe(["webhooks"]);
    let lastPrune = 0;
    this.loop = (async () => {
      try {
        while (!this.stopped) {
          try {
            const n = await this.tick();
            if (n >= (this.opts.batch ?? 10)) continue;
            if (Date.now() - lastPrune > 3_600_000) {
              lastPrune = Date.now();
              await this.pg.query("DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days' AND state IN ('succeeded','dead')");
            }
            const wait = await this.nextDueMs();
            await sub.wait({ liveMs: wait, pollMs: Math.min(wait, 5000) });
          } catch {
            console.error("Webhook dispatcher unavailable");
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      } finally {
        sub.close();
      }
    })();
  }

  async stop() {
    this.stopped = true;
    bus.dispatch("webhooks");
    await this.loop;
  }
}

export const webhookDispatcher = new WebhookDispatcher();

// ---- API -----------------------------------------------------------------------------------------

const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
export const webhookCreateSchema = z
  .object({ url: z.string().max(2000), events: eventsSchema, description: z.string().max(200).optional() })
  .strict();
export const webhookUpdateSchema = z
  .object({ url: z.string().max(2000).optional(), events: eventsSchema.optional(), description: z.string().max(200).optional(), enabled: z.boolean().optional() })
  .strict();

/** HTTPS on 443, no credentials, and every resolved address public (SSRF guard). */
export async function validateWebhookUrl(raw: string, resolve = resolveNetworkAddresses) {
  let url: URL;
  try {
    url = approvedUrl(raw);
  } catch (error) {
    throw new Error(`Webhook 地址无效：${(error as Error).message}`);
  }
  try {
    await resolve(url.hostname, AbortSignal.timeout(5000));
  } catch (error) {
    throw new Error(`Webhook 地址无法解析为公网地址：${(error as Error).message}`);
  }
  return url.toString();
}

const view = (row: any) => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: row.events,
  enabled: row.enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const deliveryView = (row: any) => ({
  id: row.id,
  event: row.event,
  eventId: row.event_id,
  state: row.state,
  attempts: row.attempts,
  nextAttemptAt: row.state === "pending" ? row.next_attempt_at : null,
  lastStatus: row.last_status,
  lastError: row.last_error,
  lastAttemptAt: row.last_attempt_at,
  deliveredAt: row.delivered_at,
  createdAt: row.created_at,
});

// Self-test receiver: last receipts per webhook, in memory only (bounded).
const sinkReceipts = new Map<string, Array<Record<string, unknown>>>();
const SINK_KEEP = 20;
const SINK_MAX_WEBHOOKS = 500;

export function registerWebhookSink(app: Hono<CloudEnv>, lookup = async (id: string) =>
  (await db.query("SELECT secret FROM webhooks WHERE id=$1", [id])).rows[0]?.secret as string | undefined) {
  // Public, unauthenticated: only accepts deliveries that carry a valid signature of an existing webhook.
  app.post("/v1/webhook-sink", async (c) => {
    const id = c.req.header("x-pig-webhook-id") || "";
    const body = await c.req.text();
    if (!/^wh_[a-f0-9]{32}$/.test(id) || body.length > 65_536) return c.json({ error: "invalid delivery" }, 400);
    const stored = await lookup(id);
    let result: ReturnType<typeof verifySignature> = { ok: false, reason: "unknown webhook" };
    try {
      if (stored) result = verifySignature(decryptSecret(stored), c.req.header("x-pig-signature"), body);
    } catch {
      result = { ok: false, reason: "secret unavailable" };
    }
    if (!result.ok) return c.json({ error: "signature verification failed" }, 401);
    if (!sinkReceipts.has(id) && sinkReceipts.size >= SINK_MAX_WEBHOOKS) sinkReceipts.delete(sinkReceipts.keys().next().value!);
    const list = sinkReceipts.get(id) ?? [];
    list.unshift({
      deliveryId: c.req.header("x-pig-delivery"),
      eventId: c.req.header("x-pig-event-id"),
      event: c.req.header("x-pig-event"),
      verified: true,
      signatureAgeS: Math.floor(Date.now() / 1000) - result.timestamp,
      receivedAt: new Date().toISOString(),
    });
    sinkReceipts.set(id, list.slice(0, SINK_KEEP));
    return c.body(null, 204);
  });
}

export function registerWebhookRoutes(app: Hono<CloudEnv>, validate = validateWebhookUrl) {
  const own = async (id: string, owner: string) =>
    (await db.query("SELECT * FROM webhooks WHERE id=$1 AND owner_id=$2", [id, owner])).rows[0];
  const parse = async <T>(schema: z.ZodType<T>, c: any) => schema.safeParse(await c.req.json().catch(() => null));

  app.get("/v1/webhooks", async (c) => {
    const { rows } = await db.query("SELECT * FROM webhooks WHERE owner_id=$1 ORDER BY created_at", [c.get("principal").id]);
    return c.json({ webhooks: rows.map(view), events: WEBHOOK_EVENTS });
  });
  app.post("/v1/webhooks", async (c) => {
    const body = await parse(webhookCreateSchema, c);
    if (!body.success) return c.json({ error: "参数无效", issues: body.error.issues.map((i) => i.message) }, 400);
    const owner = c.get("principal").id;
    let url: string;
    try {
      url = await validate(body.data.url);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const count = (await db.query("SELECT count(*)::int AS n FROM webhooks WHERE owner_id=$1", [owner])).rows[0].n;
    if (count >= MAX_WEBHOOKS_PER_OWNER) return c.json({ error: `每个账号最多 ${MAX_WEBHOOKS_PER_OWNER} 个 Webhook` }, 409);
    const secret = newWebhookSecret();
    const id = "wh_" + randomUUID().replace(/-/g, "");
    const { rows } = await db.query(
      "INSERT INTO webhooks(id,owner_id,url,description,events,secret) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [id, owner, url, body.data.description ?? "", [...new Set(body.data.events)], encryptSecret(secret)],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [owner, "webhook:create:" + id]);
    // The signing secret is shown once; only an encrypted copy is stored.
    return c.json({ ...view(rows[0]), secret }, 201);
  });
  app.get("/v1/webhooks/:id", async (c) => {
    const row = await own(c.req.param("id"), c.get("principal").id);
    return row ? c.json(view(row)) : c.json({ error: "Webhook 不存在" }, 404);
  });
  app.patch("/v1/webhooks/:id", async (c) => {
    const owner = c.get("principal").id;
    const row = await own(c.req.param("id"), owner);
    if (!row) return c.json({ error: "Webhook 不存在" }, 404);
    const body = await parse(webhookUpdateSchema, c);
    if (!body.success) return c.json({ error: "参数无效", issues: body.error.issues.map((i) => i.message) }, 400);
    let url = row.url;
    if (body.data.url !== undefined) {
      try {
        url = await validate(body.data.url);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    }
    const { rows } = await db.query(
      "UPDATE webhooks SET url=$3,description=$4,events=$5,enabled=$6,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *",
      [row.id, owner, url, body.data.description ?? row.description, body.data.events ? [...new Set(body.data.events)] : row.events, body.data.enabled ?? row.enabled],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [owner, "webhook:update:" + row.id]);
    return c.json(view(rows[0]));
  });
  app.delete("/v1/webhooks/:id", async (c) => {
    const owner = c.get("principal").id;
    const r = await db.query("DELETE FROM webhooks WHERE id=$1 AND owner_id=$2", [c.req.param("id"), owner]);
    if (!r.rowCount) return c.json({ error: "Webhook 不存在" }, 404);
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [owner, "webhook:delete:" + c.req.param("id")]);
    return c.json({ ok: true });
  });
  app.post("/v1/webhooks/:id/rotate-secret", async (c) => {
    const owner = c.get("principal").id;
    const secret = newWebhookSecret();
    const r = await db.query("UPDATE webhooks SET secret=$3,updated_at=now() WHERE id=$1 AND owner_id=$2", [c.req.param("id"), owner, encryptSecret(secret)]);
    if (!r.rowCount) return c.json({ error: "Webhook 不存在" }, 404);
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [owner, "webhook:rotate-secret:" + c.req.param("id")]);
    return c.json({ id: c.req.param("id"), secret });
  });
  app.post("/v1/webhooks/:id/ping", async (c) => {
    const row = await own(c.req.param("id"), c.get("principal").id);
    if (!row) return c.json({ error: "Webhook 不存在" }, 404);
    const eventId = "evt_ping_" + randomUUID().replace(/-/g, "");
    const deliveryId = "whd_" + randomUUID().replace(/-/g, "");
    await db.query(
      "INSERT INTO webhook_deliveries(id,webhook_id,event_id,event,payload) VALUES($1,$2,$3,'ping',$4)",
      [deliveryId, row.id, eventId, { id: eventId, type: "ping", createdAt: new Date().toISOString(), data: { webhookId: row.id } }],
    );
    await db.query("SELECT pg_notify('pig_bus','webhooks')");
    return c.json({ deliveryId, eventId }, 202);
  });
  app.get("/v1/webhooks/:id/deliveries", async (c) => {
    const row = await own(c.req.param("id"), c.get("principal").id);
    if (!row) return c.json({ error: "Webhook 不存在" }, 404);
    const limit = Math.max(1, Math.min(100, Number(c.req.query("limit")) || 50));
    const { rows } = await db.query(
      "SELECT * FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC, id LIMIT $2",
      [row.id, limit],
    );
    return c.json({ deliveries: rows.map(deliveryView) });
  });
  app.post("/v1/webhooks/:id/deliveries/:delivery/redeliver", async (c) => {
    const row = await own(c.req.param("id"), c.get("principal").id);
    if (!row) return c.json({ error: "Webhook 不存在" }, 404);
    const r = await db.query(
      "UPDATE webhook_deliveries SET state='pending',attempts=0,next_attempt_at=now(),lease_until=NULL WHERE id=$1 AND webhook_id=$2 AND state IN ('succeeded','dead','pending') RETURNING id",
      [c.req.param("delivery"), row.id],
    );
    if (!r.rowCount) return c.json({ error: "投递记录不存在或正在投递" }, 404);
    await db.query("SELECT pg_notify('pig_bus','webhooks')");
    return c.json({ id: c.req.param("delivery"), state: "pending" }, 202);
  });
  app.get("/v1/webhooks/:id/sink-receipts", async (c) => {
    const row = await own(c.req.param("id"), c.get("principal").id);
    if (!row) return c.json({ error: "Webhook 不存在" }, 404);
    return c.json({ receipts: sinkReceipts.get(row.id) ?? [] });
  });
}
