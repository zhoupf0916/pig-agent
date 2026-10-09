# 事件总线（LISTEN/NOTIFY）

云端的流式输出、A2A 阻塞调用、审批轮询和 Runner 领取任务，原来都用固定间隔查询数据库。现在由 PostgreSQL 的 `LISTEN/NOTIFY` 唤醒，数据库仍然是唯一事实来源。

## 组成

- **触发器**（迁移 `0002 event_bus_triggers`）：在 `pig_bus` 频道发送短键，不携带业务数据。

  | 键 | 触发来源 |
  |---|---|
  | `ev:<run>` | 写入 `events`（语句级，同一语句多行只通知一次） |
  | `run:<run>` | `runs` 的 state、error、updated_at 或 conversation_id 变化；审批变化 |
  | `conv:<conversation>` | 会话内的运行、事件、审批、工作区版本变化 |
  | `convrow:<conversation>` | 会话本身被修改或删除 |
  | `approval:<id>` | 审批创建或状态变化 |
  | `queue` | 新建运行、运行状态变化（包括重新排队、释放并发） |
  | `worker:<id>` | Runner 启用、容量、draining 或实例变化 |
  | `auth` | 账号、会话令牌、空间成员、共享项目变化 |

  只更新租约（`lease_until`）不会发通知。
- **`apps/cloud/src/event-bus.ts`**：每个 cloud 进程一条独立的 LISTEN 连接，把键分发给本进程的订阅者。
  - 断线后按 1 s→10 s 退避重连，期间所有等待退回原来的轮询间隔。
  - 重连成功后唤醒全部订阅者重新读库（`resync`），弥补断线期间可能漏掉的通知。
- **连接池**：`PG_POOL_MAX`（默认 10，范围 2–100）。流和长轮询在等待时不占用数据库连接。

## 使用方

| 位置 | 之前 | 之后 |
|---|---|---|
| `/v1/runs/:id/events` SSE | 每 100 / 700 ms 查一次（身份 + 事件 + 状态） | 收到 `ev:`、`run:` 或 `auth` 时读取。每 10 s 心跳时顺便重读一次。身份每 30 s 或收到 `auth` 时复查 |
| `/v1/conversations/:id/events` SSE | 每 100 / 500 ms 查一次 | 收到 `conv:`、`convrow:` 或 `auth` 时读取，其余同上 |
| A2A `message/send`（blocking） | 每 1 s 查询任务 | 收到 `run:` 时读取 |
| `/internal/approvals/:id/poll` | Runner 每 700 ms 请求一次 | Runner 带 `X-Pig-Wait-Ms: 3000`，控制面最多等 3 s，审批变化时立即返回 |
| `/internal/claim` | 每个空闲槽位每 1 s 请求一次 | Worker 带 `X-Pig-Wait-Ms: 10000`（`WORKER_CLAIM_WAIT_MS`，0 表示关闭），控制面在有可领取任务时立即返回 |

## 兼容与回滚

- **旧 Runner / Worker** 不带等待头，控制面立即返回，行为与之前完全一致。
- **新 Runner / Worker** 遇到旧控制面时会立即收到回复，客户端据此识别，保留原来的 700 ms / 1 s 间隔，不会形成空转。
- **旧 cloud** 运行在带触发器的库上，没有监听者，通知会被丢弃，无副作用。
- 回滚只需回退镜像，触发器可以保留。如需移除，新增一个迁移执行 `DROP TRIGGER … / DROP FUNCTION pig_bus_*`。
