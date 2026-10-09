# Webhooks 与 OpenAPI

## Webhook

账号可以登记最多 10 个 HTTPS Webhook。任务结束或出现待审批的工具调用时，云端会向这些地址发送签名的 POST 请求。

| 事件 | 触发时机 | `data` |
| --- | --- | --- |
| `run.succeeded` / `run.failed` / `run.cancelled` | 任务进入终态 | `run`：id、state、error、conversationId、projectId、createdAt、updatedAt |
| `approval.requested` | 新的工具调用审批 | `approval`：id、runId、tool、createdAt（不含参数）；`run`：id、conversationId、projectId |
| `ping` | `POST /v1/webhooks/:id/ping` | `webhookId` |

只投递 Webhook 所有者本人的任务（`runs.owner_id`）。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/v1/webhooks` | 列表 / 创建。创建时返回 `secret`（`whsec_…`），只显示这一次 |
| GET / PATCH / DELETE | `/v1/webhooks/:id` | 详情 / 修改 url、events、description、enabled / 删除（投递日志一并删除） |
| POST | `/v1/webhooks/:id/rotate-secret` | 轮换签名密钥，新密钥只返回一次 |
| POST | `/v1/webhooks/:id/ping` | 发送测试事件 |
| GET | `/v1/webhooks/:id/deliveries?limit=50` | 投递日志：状态、次数、最后状态码/错误、下次重试时间 |
| POST | `/v1/webhooks/:id/deliveries/:delivery/redeliver` | 重新投递（重置次数） |

```bash
curl -s https://HOST/v1/webhooks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/pig-hook","events":["run.succeeded","run.failed"]}'
```

地址限制：只允许 `https://` 且端口为 443，不能带用户名密码或片段，解析结果必须全部是公网 IPv4。每次投递都固定连接到校验过的地址（防 DNS rebinding），不跟随重定向（3xx 视为失败）。

### 签名

```
X-Pig-Event: run.succeeded
X-Pig-Event-Id: evt_…          # 同一事件重试时不变，用于去重
X-Pig-Delivery: whd_…
X-Pig-Webhook-Id: wh_…
X-Pig-Signature: t=1760000000,v1=<hex>
```

`v1 = hex(HMAC-SHA256(secret, "<t>.<原始请求体>"))`。接收方需要：

1. 用**原始字节**（不要先解析再序列化）计算签名，并用常量时间比较；
2. 拒绝 `t` 与当前时间相差超过 5 分钟的请求（防重放）；
3. 按 `X-Pig-Event-Id` 去重（投递语义是至少一次）。

Node.js 校验示例：

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1?.length === 64 && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

### 投递与重试

- 返回 2xx 即成功。超时 10 秒。
- 失败后按 30 秒 × 2^(n-1) 重试（±20% 抖动；有 `Retry-After` 时按其值，最长 1 小时），即约 30 秒、1、2、4、8、16、32 分钟。最多 8 次，之后标记为 `dead`，可手动重投。
- 已完成（`succeeded` / `dead`）的投递记录保留 30 天。

### 实现

- **事务性 outbox**（迁移 `0003 webhooks`）：`runs` 状态进入终态、`approvals` 插入时，触发器在同一事务里写 `webhook_deliveries`，并 `pg_notify('pig_bus','webhooks')`。事务回滚就不会产生投递。账号没有启用的 Webhook 时只做一次索引查询。
- **分发器**（`apps/cloud/src/webhooks.ts`）：每个 cloud 进程一个。用 `FOR UPDATE SKIP LOCKED` 领取到期投递，租约 60 秒，多实例不会重复发送。由事件总线唤醒，并按最早的到期时间定时，重试准时触发，不需要轮询。
- 密钥用 `ENCRYPTION_KEY` 以 AES-256-GCM 加密保存，接口不再返回明文。
- 生产环境 cloud 需要出网（腾讯云覆盖配置中 cloud 已在 `egress` 网络），DNS 与网关一致使用 `NETWORK_DNS_MODE=public` / `alidns`。本地 `infra/cloud/compose.yml` 中 cloud 只在 `control` 网络，投递会以连接错误进入重试。

### 自测接收端

`POST /v1/webhook-sink` 是内置的接收端，用于部署验收：只接受已存在 Webhook 的有效签名（否则 401），在内存里保留每个 Webhook 最近 20 条回执，用 `GET /v1/webhooks/:id/sink-receipts` 查看（仅所有者）。`scripts/deploy/e2e-remote.sh` 用它验证「服务器 → 自己的公网地址 → 验签」整条链路。

## OpenAPI

- `GET /openapi.json`：OpenAPI 3.1 规范（公开，缓存 5 分钟），覆盖认证、任务、会话、定时任务、Webhook、A2A 等稳定接口。
- `GET /api-docs`：只读文档页（无内联脚本，符合现有 CSP）。
- `apps/cloud/src/openapi.test.ts` 检查规范中的每个路径和方法都能在源码路由中找到，并且所有 Webhook 路由都已写入文档。
