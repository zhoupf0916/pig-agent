import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { db } from "./db.ts";
import { bus } from "./event-bus.ts";
import { adminOnly, recentFailover, recentHttp, recentModel, spanStore, trim } from "./observability.ts";
import { storageHealth } from "./storage.ts";
import type { CloudEnv } from "./types.ts";

/**
 * Built-in alerting. Rules are evaluated every 30 s by one cloud instance at a time (advisory lock).
 * A rule must hold for its `forS` before it fires; firing/resolution is stored in `alerts` and announced
 * to admins' webhooks subscribed to `alert.firing` / `alert.resolved` (signed, retried like any webhook).
 */
export type Severity = "info" | "warning" | "critical";
export type Observation = { firing: boolean; value: number; summary: string };
export type Rule = { id: string; severity: Severity; forS: number; description: string; check: () => Promise<Observation> };
const EVAL_LOCK = 71839031;

const ratio = (a: number, b: number) => (b ? a / b : 0);

export const rules: Rule[] = [
  {
    id: "runners_offline",
    severity: "critical",
    forS: 60,
    description: "没有在线的 Runner（30 秒内无心跳），任务无法执行",
    async check() {
      const r = (await db.query("SELECT count(*) FILTER (WHERE seen_at > now() - interval '30 seconds')::int AS online, count(*)::int AS enabled FROM workers WHERE enabled")).rows[0];
      return { firing: r.enabled > 0 && r.online === 0, value: r.online, summary: `在线 Runner ${r.online}/${r.enabled}` };
    },
  },
  {
    id: "queue_stalled",
    severity: "warning",
    forS: 0,
    description: "最早排队的任务等待超过 5 分钟",
    async check() {
      const age = Number((await db.query("SELECT coalesce(extract(epoch FROM now()-min(created_at)),0) AS age FROM runs WHERE state='queued'")).rows[0].age);
      return { firing: age > 300, value: Math.round(age), summary: `最早排队任务已等待 ${Math.round(age)} 秒` };
    },
  },
  {
    id: "model_provider_errors",
    severity: "critical",
    forS: 0,
    description: "模型服务 10 分钟内出现 HTTP 402（余额不足）或至少 3 次错误",
    async check() {
      trim(recentModel, 30 * 60_000);
      const since = Date.now() - 10 * 60_000;
      const window = recentModel.filter((m) => m.t >= since);
      const errors = window.filter((m) => !/^2\d\d$/.test(m.status));
      const has402 = errors.some((m) => m.status === "402");
      return {
        firing: has402 || errors.length >= 3,
        value: errors.length,
        summary: has402 ? `模型服务返回 HTTP 402（余额不足），10 分钟内错误 ${errors.length}/${window.length}` : `模型服务 10 分钟内错误 ${errors.length}/${window.length}`,
      };
    },
  },
  {
    id: "model_failover",
    severity: "warning",
    forS: 0,
    description: "10 分钟内至少 3 次模型调用切换到备用渠道（主渠道异常）",
    async check() {
      trim(recentFailover, 30 * 60_000);
      const since = Date.now() - 10 * 60_000;
      const n = recentFailover.filter((f) => f.t >= since).reduce((a, f) => a + f.failed, 0);
      return { firing: n >= 3, value: n, summary: `10 分钟内 ${n} 次主渠道失败后切换备用渠道` };
    },
  },
  {
    id: "run_failure_rate",
    severity: "warning",
    forS: 0,
    description: "30 分钟内结束的任务（至少 4 个）失败率 ≥ 50%",
    async check() {
      const r = (await db.query("SELECT count(*)::int AS done, count(*) FILTER (WHERE state='failed')::int AS failed FROM runs WHERE state IN ('succeeded','failed') AND updated_at > now() - interval '30 minutes'")).rows[0];
      const rate = ratio(r.failed, r.done);
      return { firing: r.done >= 4 && rate >= 0.5, value: Math.round(rate * 100) / 100, summary: `30 分钟内失败 ${r.failed}/${r.done}` };
    },
  },
  {
    id: "http_5xx",
    severity: "warning",
    forS: 0,
    description: "5 分钟内 API 5xx 比例 ≥ 5%（至少 20 个请求）",
    async check() {
      trim(recentHttp, 10 * 60_000);
      const since = Date.now() - 5 * 60_000;
      const window = recentHttp.filter((r) => r.t >= since);
      const errors = window.filter((r) => r.status >= 500).length;
      const rate = ratio(errors, window.length);
      return { firing: window.length >= 20 && rate >= 0.05, value: Math.round(rate * 1000) / 1000, summary: `5 分钟内 5xx ${errors}/${window.length}` };
    },
  },
  {
    id: "webhook_dead",
    severity: "warning",
    forS: 0,
    description: "1 小时内有 Webhook 投递在 8 次重试后失败",
    async check() {
      const n = (await db.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE state='dead' AND last_attempt_at > now() - interval '1 hour'")).rows[0].n;
      return { firing: n > 0, value: n, summary: `1 小时内 ${n} 个 Webhook 投递失败` };
    },
  },
  {
    id: "queue_dead_letters",
    severity: "warning",
    forS: 0,
    description: "1 小时内有任务转入死信（多次未能启动或执行中断），需管理员核验或重放",
    async check() {
      const n = (await db.query("SELECT count(*)::int AS n FROM runs WHERE dead_lettered_at > now() - interval '1 hour' AND replayed_as IS NULL AND state='failed'")).rows[0].n;
      return { firing: n > 0, value: n, summary: `1 小时内 ${n} 个任务转入死信` };
    },
  },
  {
    id: "event_bus_down",
    severity: "warning",
    forS: 60,
    description: "事件总线 LISTEN 连接断开，实时推送退化为轮询",
    async check() {
      return { firing: !bus.live, value: bus.live ? 1 : 0, summary: bus.live ? "事件总线正常" : "事件总线未连接" };
    },
  },
  {
    id: "storage_degraded",
    severity: "warning",
    forS: 300,
    description: "对象存储不可达或有数据长时间未复制（读取回退到 Postgres 原件）",
    async check() {
      const h = await storageHealth();
      const firing = h.configured && (!h.reachable || h.pending > 0);
      return { firing, value: h.reachable ? h.pending : -1, summary: !h.configured ? "未启用对象存储" : !h.reachable ? "对象存储不可达" : `${h.pending} 个文件待复制` };
    },
  },
  {
    id: "telemetry_dropping",
    severity: "info",
    forS: 0,
    description: "追踪数据因队列已满被丢弃",
    async check() {
      const d = spanStore.stats.dropped - droppedBaseline;
      droppedBaseline = spanStore.stats.dropped;
      return { firing: d > 0, value: d, summary: `本周期丢弃 ${d} 个 span` };
    },
  },
];
let droppedBaseline = 0;

const pendingSince = new Map<string, number>();
export type Transition = { rule: Rule; state: "firing" | "resolved"; observation: Observation };

/** One evaluation pass. Returns transitions (also persisted and announced). */
export async function evaluate(now = Date.now(), list = rules): Promise<Transition[]> {
  const client = await db.connect();
  const transitions: Transition[] = [];
  try {
    if (!(await client.query("SELECT pg_try_advisory_lock($1) AS ok", [EVAL_LOCK])).rows[0].ok) return [];
    try {
      const firing = new Map((await client.query("SELECT rule FROM alerts WHERE state='firing'")).rows.map((r) => [r.rule as string, true]));
      for (const rule of list) {
        let obs: Observation;
        try {
          obs = await rule.check();
        } catch {
          continue;
        }
        if (obs.firing) {
          const since = pendingSince.get(rule.id) ?? now;
          pendingSince.set(rule.id, since);
          if (firing.has(rule.id)) {
            await client.query("UPDATE alerts SET summary=$2,value=$3,updated_at=now() WHERE rule=$1 AND state='firing'", [rule.id, obs.summary, obs.value]);
          } else if (now - since >= rule.forS * 1000) {
            const r = await client.query(
              "INSERT INTO alerts(rule,severity,state,summary,value) VALUES($1,$2,'firing',$3,$4) ON CONFLICT (rule) WHERE state='firing' DO NOTHING RETURNING id",
              [rule.id, rule.severity, obs.summary, obs.value],
            );
            if (r.rowCount) transitions.push({ rule, state: "firing", observation: obs });
          }
        } else {
          pendingSince.delete(rule.id);
          if (firing.has(rule.id)) {
            const r = await client.query("UPDATE alerts SET state='resolved',resolved_at=now(),updated_at=now(),value=$2 WHERE rule=$1 AND state='firing' RETURNING id", [rule.id, obs.value]);
            if (r.rowCount) transitions.push({ rule, state: "resolved", observation: obs });
          }
        }
      }
      for (const t of transitions) {
        console.warn(`ALERT ${t.state.toUpperCase()} ${t.rule.severity} ${t.rule.id}: ${t.observation.summary}`);
        await announce(client, t.rule, t.state, t.observation);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [EVAL_LOCK]);
    }
  } finally {
    client.release();
  }
  return transitions;
}

async function announce(client: { query: typeof db.query }, rule: Pick<Rule, "id" | "severity" | "description">, state: "firing" | "resolved", obs: Observation, onlyOwner?: string) {
  const eventId = "evt_alert_" + randomUUID().replace(/-/g, "");
  const event = `alert.${state}`;
  const payload = {
    id: eventId,
    type: event,
    createdAt: new Date().toISOString(),
    data: { alert: { rule: rule.id, severity: rule.severity, state, description: rule.description, summary: obs.summary, value: obs.value } },
  };
  await client.query(
    "SELECT pig_webhook_enqueue(p.id, $1, $2, $3::jsonb) FROM principals p WHERE p.role='admin' AND p.enabled AND ($4::text IS NULL OR p.id=$4)",
    [event, eventId, JSON.stringify(payload), onlyOwner ?? null],
  );
  return eventId;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
export function startAlerts(intervalMs = Number(process.env.ALERT_EVAL_INTERVAL_MS) || 30_000) {
  timer ??= setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await evaluate();
    } catch {
      console.error("Alert evaluation unavailable");
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
}

export function registerAlertRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/admin/alerts", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const active = (await db.query("SELECT * FROM alerts WHERE state='firing' ORDER BY started_at DESC")).rows;
    const recent = (await db.query("SELECT * FROM alerts ORDER BY started_at DESC LIMIT 50")).rows;
    const view = (r: any) => ({ id: Number(r.id), rule: r.rule, severity: r.severity, state: r.state, summary: r.summary, value: r.value, startedAt: r.started_at, resolvedAt: r.resolved_at, updatedAt: r.updated_at });
    return c.json({
      active: active.map(view),
      recent: recent.map(view),
      rules: rules.map((r) => ({ id: r.id, severity: r.severity, forSeconds: r.forS, description: r.description })),
    });
  });
  // Sends a synthetic alert.firing to the calling admin's subscribed webhooks (end-to-end notification test).
  app.post("/v1/admin/alerts/test", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const eventId = await announce(db, { id: "synthetic_test", severity: "info", description: "测试告警通知链路" }, "firing", { firing: true, value: 1, summary: "这是一条测试告警" }, c.get("principal").id);
    await db.query("SELECT pg_notify('pig_bus','webhooks')");
    return c.json({ eventId }, 202);
  });
}
