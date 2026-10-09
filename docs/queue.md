# 任务队列：领取、重试与死信（U3）

队列仍是自研的 PostgreSQL 队列：租约、尝试围栏、代次、完成 outbox、安全检查点续跑都保留。
通用队列（pg-boss / graphile-worker）不支持“每用户/每项目并发 + 公平轮转 + 审批挂起 + 尝试围栏”，因此不替换。

## 领取

- 领取在短事务里进行，全局 advisory lock（`71839022`）让全局/用户/项目/节点容量在多个控制面之间保持权威。
- 候选选择改为**按账号优先**（`queue.ts`）：
  1. 用递归 CTE 对 `runs_queued_owner` 部分索引做 loose index scan，找出有排队任务、已启用且未达用户并发上限的账号，按“最近被服务时间（空值优先）→ 最早排队任务”排序；
  2. 依次取每个账号最早的可领取任务（执行规格、项目权限与并发、重试等待），`FOR UPDATE SKIP LOCKED LIMIT 1`，第一个命中即返回。
- 公平语义与旧 SQL 一致（集成测试逐条比对领取顺序），但锁内耗时不再随队列长度增长：
  旧 SQL 每次都要对整个队列排序。

| 场景（真实 PostgreSQL，8 个并发领取者） | 旧 SQL | 新 SQL |
|---|---|---|
| 500 条排队（100 账号） | 99 次/秒，p50 66 ms | 105 次/秒，p50 58 ms |
| 10 000 条排队（200 账号） | 11 次/秒，p50 674 ms，p95 947 ms | 91 次/秒，p50 66 ms，p95 122 ms |
| 候选选择本身（10 000 条） | 66–72 ms | 3–4 ms |

- 回滚开关：`QUEUE_CLAIM=legacy` 恢复旧 SQL（也遵守重试等待），无需改库。
- 指标：`pig_queue_claim_seconds{result=claimed|empty}`。

## 重试与退避

只有**可证明没有副作用**的失败才自动重试：

| 情况 | 处理 | 类别 |
|---|---|---|
| 尝试还没开始执行（仍在 preparing、没有 started_at）：租约丢失或 Worker 报告失败 | 指数退避后重排（10 s、20 s，±20% 抖动），最多 3 次尝试；之后失败并转入死信 | `prestart` |
| 执行中租约丢失，有安全检查点 | 从检查点续跑（最多 2 次），同样退避 | `worker_lost` |
| 执行中租约丢失，没有安全检查点 | 失败并转入死信（结果不确定，不自动重放工具或审批） | `interrupted` |
| 执行后报告模型 429/5xx/上游不可用 | 失败并转入死信（网关已做渠道切换与重试；任务级重放可能重复执行工具） | `model_unavailable` |
| 任务本身失败 | 失败，不进死信 | `task` |
| 停止中 | 已取消 | `cancelled` |

- 新列（迁移 0008，均为扩展）：`attempt_count`、`next_attempt_at`、`last_error_class`、`dead_lettered_at`、`replayed_as`。
- 领取会跳过 `next_attempt_at` 未到的任务；排队超时与截止时间照常生效。
- 指标：`pig_queue_retries_total{class}`、`pig_queue_dead_letters_total{class}`、`pig_queue_runs{kind=ready|delayed|dead_letter}`。

## 死信与重放

- 管理台「任务与日志」下方是「队列与死信」：可领取/等待重试/执行中/死信数量、最久排队时间，以及死信列表。
- 「重放」用相同输入为同一账号、同一会话**新建**一次运行（`parent_run_id` 指向原任务），原任务保留为失败记录并移出死信列表；每次重放都写审计。工具可能再次执行，所以需要管理员确认。
- API：`GET /v1/admin/queue`、`GET /v1/admin/queue/dead-letters?limit=50`、`POST /v1/admin/queue/dead-letters/:id/replay`（仅管理员）。
- 告警 `queue_dead_letters`：1 小时内有新的未重放死信。

## 为什么不换掉全局领取锁

基准表明，在当前规模（≤128 全局并发、单机 4 个 Runner）下锁内耗时主要来自候选选择；改成按账号优先后约 2–4 ms。
计数表 + 行锁方案会让每次任务状态变化都去更新热点行，`/finish` 这类长事务反而会阻塞领取，还要处理计数漂移，因此暂不采用。
需要多控制面高吞吐时，再考虑把全局并发拆成分片计数行。
