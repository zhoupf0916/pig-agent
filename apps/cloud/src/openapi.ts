import { MAX_ATTEMPTS, WEBHOOK_EVENTS } from "./webhook-events.ts";

/**
 * Hand-written OpenAPI 3.1 description of the public, stable surface (served at /openapi.json and rendered
 * at /api-docs). `openapi.test.ts` checks every documented path against the route table in the sources.
 */
type Op = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const id = (name = "id", description = "资源 ID") => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const idem = { name: "Idempotency-Key", in: "header", required: false, description: "幂等键（≤120 字符），重复提交返回同一资源", schema: { type: "string", maxLength: 120 } };
const errors = { "400": json(ref("Error"), "参数无效"), "401": json(ref("Error"), "未认证"), "404": json(ref("Error"), "不存在") };
const op = (tag: string, summary: string, extra: Op = {}): Op => ({ tags: [tag], summary, responses: { "200": json({ type: "object" }), ...errors }, ...extra });

const webhookEvents = { type: "string", enum: [...WEBHOOK_EVENTS] };

export function openApiSpec(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Pig Agent Cloud API",
      version: "1.0.0",
      description:
        "Pig Agent 云端 API。认证：`POST /auth/web/login` 获取会话，浏览器使用 Cookie，脚本可把会话令牌作为 `Authorization: Bearer <token>`。" +
        "所有 `/v1/*` 接口受 nginx 速率限制（约 10 次/秒）。Webhook 签名校验见 `components.schemas.WebhookEvent` 的说明与 /api-docs。",
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    security: [{ bearer: [] }, { cookie: [] }],
    tags: [
      { name: "auth", description: "登录与会话" },
      { name: "runs", description: "任务：创建、查询、事件流、审批" },
      { name: "conversations", description: "会话" },
      { name: "schedules", description: "定时任务" },
      { name: "webhooks", description: "签名的出站 Webhook、投递日志与重投" },
      { name: "a2a", description: "Agent-to-Agent (JSON-RPC)" },
      { name: "observability", description: "追踪、指标与告警（管理接口需管理员）" },
      { name: "meta", description: "健康检查与发现" },
    ],
    paths: {
      "/health": { get: op("meta", "健康检查", { security: [], responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, modelMode: { type: "string" } } }) } }) },
      "/openapi.json": { get: op("meta", "本 OpenAPI 文档", { security: [] }) },
      "/.well-known/agent-card.json": { get: op("a2a", "A2A Agent Card", { security: [] }) },
      "/auth/web/login": {
        post: op("auth", "账号密码登录（设置 pig_web_session Cookie）", {
          security: [],
          requestBody: body({ type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string", format: "password" } } }),
          responses: { "200": json({ type: "object" }), "401": json(ref("Error"), "账号或密码错误"), "429": json(ref("Error"), "登录过于频繁") },
        }),
      },
      "/auth/web/logout": { post: op("auth", "注销当前会话") },
      "/v1/me": { get: op("auth", "当前账号", { responses: { "200": json({ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string", enum: ["admin", "member"] } } }) } }) },
      "/v1/runs": {
        get: op("runs", "列出任务"),
        post: op("runs", "创建任务", {
          parameters: [idem],
          requestBody: body(ref("RunCreate")),
          responses: { "201": json(ref("Run"), "已创建"), "200": json(ref("Run"), "幂等重放"), "409": json(ref("Error")), "429": json(ref("Error"), "待执行任务过多"), ...errors },
        }),
      },
      "/v1/runs/{id}": { get: op("runs", "任务详情", { parameters: [id()], responses: { "200": json(ref("Run")), ...errors } }) },
      "/v1/runs/{id}/events": {
        get: op("runs", "任务事件流（Server-Sent Events，支持 Last-Event-ID 续传）", {
          parameters: [id(), { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }],
          responses: { "200": { description: "text/event-stream", content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors },
        }),
      },
      "/v1/runs/{id}/eventlog": { get: op("runs", "任务事件（JSON）", { parameters: [id()] }) },
      "/v1/runs/{id}/artifacts": { get: op("runs", "任务产物列表", { parameters: [id()] }) },
      "/v1/runs/{id}/abort": { post: op("runs", "取消任务", { parameters: [id()] }) },
      "/v1/runs/{id}/follow-ups": {
        post: op("runs", "在同一会话追问", {
          parameters: [id(), idem],
          requestBody: body({ type: "object", required: ["prompt"], properties: { prompt: { type: "string", maxLength: 32000 } } }),
          responses: { "201": json(ref("Run"), "已创建"), ...errors },
        }),
      },
      "/v1/runs/{id}/approvals": { get: op("runs", "待审批的工具调用", { parameters: [id()] }) },
      "/v1/runs/{id}/approvals/{approval}/decision": {
        post: op("runs", "批准或拒绝工具调用", {
          parameters: [id(), id("approval", "审批 ID")],
          requestBody: body({ type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["approve", "reject"] } } }),
        }),
      },
      "/v1/conversations": { get: op("conversations", "会话列表") },
      "/v1/conversations/{id}": { get: op("conversations", "会话详情", { parameters: [id()] }) },
      "/v1/schedules": { get: op("schedules", "定时任务列表"), post: op("schedules", "创建定时任务", { parameters: [idem] }) },
      "/v1/schedules/{id}": {
        get: op("schedules", "定时任务详情", { parameters: [id()] }),
        patch: op("schedules", "修改定时任务", { parameters: [id()] }),
        delete: op("schedules", "删除定时任务", { parameters: [id()] }),
      },
      "/v1/schedules/{id}/run": { post: op("schedules", "立即运行一次", { parameters: [id(), idem], responses: { "202": json({ type: "object" }), ...errors } }) },
      "/v1/webhooks": {
        get: op("webhooks", "Webhook 列表", { responses: { "200": json({ type: "object", properties: { webhooks: { type: "array", items: ref("Webhook") }, events: { type: "array", items: webhookEvents } } }) } }),
        post: op("webhooks", "创建 Webhook（签名密钥仅在此返回一次）", {
          requestBody: body(ref("WebhookCreate")),
          responses: { "201": json({ allOf: [ref("Webhook"), { type: "object", properties: { secret: { type: "string", description: "whsec_…，仅显示一次" } } }] }, "已创建"), "409": json(ref("Error"), "超过数量上限"), ...errors },
        }),
      },
      "/v1/webhooks/{id}": {
        get: op("webhooks", "Webhook 详情", { parameters: [id()], responses: { "200": json(ref("Webhook")), ...errors } }),
        patch: op("webhooks", "修改 Webhook（地址、事件、启停）", { parameters: [id()], requestBody: body(ref("WebhookUpdate")), responses: { "200": json(ref("Webhook")), ...errors } }),
        delete: op("webhooks", "删除 Webhook 及其投递日志", { parameters: [id()] }),
      },
      "/v1/webhooks/{id}/rotate-secret": { post: op("webhooks", "轮换签名密钥（新密钥仅返回一次）", { parameters: [id()] }) },
      "/v1/webhooks/{id}/ping": { post: op("webhooks", "发送 ping 测试事件", { parameters: [id()], responses: { "202": json({ type: "object", properties: { deliveryId: { type: "string" }, eventId: { type: "string" } } }), ...errors } }) },
      "/v1/webhooks/{id}/deliveries": {
        get: op("webhooks", "投递日志（最近优先）", {
          parameters: [id(), { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }],
          responses: { "200": json({ type: "object", properties: { deliveries: { type: "array", items: ref("WebhookDelivery") } } }), ...errors },
        }),
      },
      "/v1/webhooks/{id}/deliveries/{delivery}/redeliver": { post: op("webhooks", "重新投递（重置重试次数）", { parameters: [id(), id("delivery", "投递 ID")], responses: { "202": json({ type: "object" }), ...errors } }) },
      "/v1/runs/{id}/trace": {
        get: op("observability", "任务的分布式追踪（cloud / worker / runner / gateway 的 span 树）", { parameters: [id()], responses: { "200": json(ref("RunTrace")), ...errors } }),
      },
      "/v1/admin/metrics": {
        get: op("observability", "Prometheus 指标（文本格式）", { responses: { "200": { description: "Prometheus text 0.0.4", content: { "text/plain": { schema: { type: "string" } } } }, "403": json(ref("Error"), "需要管理员权限"), ...errors } }),
      },
      "/v1/admin/traces": {
        get: op("observability", "最近的追踪（可只看出错的）", {
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "status", in: "query", schema: { type: "string", enum: ["error"] } },
          ],
          responses: { "200": json({ type: "object", properties: { traces: { type: "array", items: { type: "object" } } } }), "403": json(ref("Error"), "需要管理员权限"), ...errors },
        }),
      },
      "/v1/admin/alerts": {
        get: op("observability", "当前告警、最近告警与规则", { responses: { "200": json({ type: "object", properties: { active: { type: "array", items: ref("Alert") }, recent: { type: "array", items: ref("Alert") }, rules: { type: "array", items: { type: "object" } } } }), "403": json(ref("Error"), "需要管理员权限"), ...errors } }),
      },
      "/v1/admin/alerts/test": {
        post: op("observability", "向自己订阅了 alert.firing 的 Webhook 发送测试告警", { responses: { "202": json({ type: "object", properties: { eventId: { type: "string" } } }), "403": json(ref("Error"), "需要管理员权限"), ...errors } }),
      },
      "/v1/a2a": { post: op("a2a", "A2A JSON-RPC 端点（message/send、message/stream、tasks/get、tasks/cancel）") },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "会话令牌或 API 令牌" },
        cookie: { type: "apiKey", in: "cookie", name: "pig_web_session" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
        Span: {
          type: "object",
          properties: {
            traceId: { type: "string" }, spanId: { type: "string" }, parentSpanId: { type: "string" },
            service: { type: "string", enum: ["cloud", "worker", "runner", "gateway"] }, name: { type: "string" },
            kind: { type: "string", enum: ["internal", "server", "client", "consumer"] }, startTime: { type: "string", format: "date-time" },
            durationMs: { type: "number" }, status: { type: "string", enum: ["ok", "error", "unset"] }, attributes: { type: "object" },
          },
        },
        RunTrace: {
          type: "object",
          properties: { traceId: { type: "string" }, rootSpanId: { type: "string" }, services: { type: "array", items: { type: "string" } }, spanCount: { type: "integer" }, truncated: { type: "boolean", description: "超过 2000 个 span 时只返回根 span 和最早的部分" }, spans: { type: "array", items: ref("Span") } },
        },
        Alert: {
          type: "object",
          properties: {
            id: { type: "integer" }, rule: { type: "string" }, severity: { type: "string", enum: ["info", "warning", "critical"] }, state: { type: "string", enum: ["firing", "resolved"] },
            summary: { type: "string" }, value: { type: "number" }, startedAt: { type: "string", format: "date-time" }, resolvedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
        RunCreate: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 32000 },
            projectId: { type: "string", pattern: "^project_[a-f0-9]{32}$" },
            requireApproval: { type: "boolean", description: "高风险工具调用是否需要人工审批（默认 true）" },
            networkPolicy: { type: "string", enum: ["ask", "blocked"], default: "ask" },
            attachmentIds: { type: "array", items: { type: "string" } },
          },
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            state: { type: "string", enum: ["queued", "preparing", "running", "cancelling", "succeeded", "failed", "cancelled"] },
            conversationId: { type: ["string", "null"] },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^wh_[a-f0-9]{32}$" },
            url: { type: "string", format: "uri" },
            description: { type: "string" },
            events: { type: "array", items: webhookEvents },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        WebhookCreate: {
          type: "object",
          additionalProperties: false,
          required: ["url", "events"],
          properties: {
            url: { type: "string", format: "uri", description: "仅公网 HTTPS（443 端口），不跟随重定向" },
            events: { type: "array", minItems: 1, items: webhookEvents },
            description: { type: "string", maxLength: 200 },
          },
        },
        WebhookUpdate: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri" },
            events: { type: "array", minItems: 1, items: webhookEvents },
            description: { type: "string", maxLength: 200 },
            enabled: { type: "boolean" },
          },
        },
        WebhookDelivery: {
          type: "object",
          properties: {
            id: { type: "string" },
            event: { type: "string" },
            eventId: { type: "string", description: "同一事件重试时保持不变，用于接收方去重" },
            state: { type: "string", enum: ["pending", "delivering", "succeeded", "dead"] },
            attempts: { type: "integer", maximum: MAX_ATTEMPTS },
            nextAttemptAt: { type: ["string", "null"], format: "date-time" },
            lastStatus: { type: ["integer", "null"] },
            lastError: { type: ["string", "null"] },
            lastAttemptAt: { type: ["string", "null"], format: "date-time" },
            deliveredAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        WebhookEvent: {
          description:
            "POST 到 Webhook 地址的请求体。请求头：X-Pig-Event、X-Pig-Event-Id、X-Pig-Delivery、X-Pig-Webhook-Id、" +
            "X-Pig-Signature: t=<unix 秒>,v1=<hex(HMAC-SHA256(secret, `${t}.${原始请求体}`))>。接收方应使用常量时间比较，并拒绝与当前时间相差超过 5 分钟的 t。" +
            `返回 2xx 视为成功；其他状态或超时（10 秒）按 30 秒 × 2^(n-1)（±20% 抖动，尊重 Retry-After）重试，最多 ${MAX_ATTEMPTS} 次后标记为 dead。`,
          type: "object",
          required: ["id", "type", "createdAt", "data"],
          properties: {
            id: { type: "string", description: "事件 ID（= X-Pig-Event-Id）" },
            type: { type: "string", enum: [...WEBHOOK_EVENTS, "ping"] },
            createdAt: { type: "string", format: "date-time" },
            data: { type: "object" },
          },
        },
      },
    },
  };
}
