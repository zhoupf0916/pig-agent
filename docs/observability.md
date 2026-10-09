# 可观测性：追踪、指标、告警与评测门禁

## 追踪（OpenTelemetry 兼容）

每个云端任务是一条 trace，trace id 就是任务 id 里的 32 位十六进制（`run_<hex>` → `<hex>`），根 span 的 id 由任务 id 确定性地算出。所以每个服务不用查库就能加入同一条 trace：

```
run                       cloud    创建 → 终态（任务结束时写入）
├─ run.queued             cloud    排队等待（被领取时写入）
├─ worker.execute         worker   一次执行尝试（内存规格、结果）
│  ├─ POST /internal/...  cloud    worker 回调（traceparent 透传）
│  └─ runner.process      worker   runner 子进程
│     └─ runner.agent     runner   智能体循环
│        ├─ chat <model>  runner   每次模型调用（模型、token、TTFT、finish reason）
│        ├─ POST /v1/chat/completions      gateway（上游状态码、模型、是否流式）
│        │  ├─ cloud /internal/authorize   gateway → cloud
│        │  └─ llm <host>                  gateway → 模型服务（不携带 traceparent）
│        ├─ POST /checkpoint · /mcp/tools  gateway → cloud
│        └─ execute_tool <name>            runner（工具名、成功/失败）
```

- 传播：W3C `traceparent`。worker → runner 通过环境变量 `TRACEPARENT`；runner → gateway、gateway/worker → cloud 通过请求头。traceparent **不会**发给第三方模型服务。
- 汇聚：gateway / worker 批量 POST 到 `/internal/telemetry/spans`（WORKER_TOKEN）；runner 的 span 通过 stdout 协议行 `{kind:"telemetry"}` 交给 worker 校验后转发（trace id 必须属于本任务）。cloud 写入 PostgreSQL `trace_spans`（迁移 `0004 observability`），默认保留 7 天（`TRACE_RETENTION_DAYS`）。
- 隐私：只导出元数据（模型名、token 数、耗时、工具名、状态码），不导出提示词、工具参数、文件内容。
- 采样：任务链路全量；普通 API 请求只记录 5xx 和 >2 s 的慢请求；心跳、事件上报、领取轮询等噪音不记录。公网请求带的 `traceparent` 会被忽略（防止外部强制写入 span），只有 `/internal/` 调用可以加入已有 trace。
- 导出到外部：设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_ENDPOINT`，会追加 `/v1/traces`）后，cloud 会把收到的 span 以 OTLP/HTTP JSON 同时转发给 Jaeger / Tempo / Collector。
- 查看：`GET /v1/runs/{id}/trace`（任务可见者）返回 span 列表和覆盖的服务；`GET /v1/admin/traces?status=error`（管理员）列出最近（出错的）trace。

## 指标（Prometheus）

`GET /internal/metrics`（`Authorization: Bearer $METRICS_TOKEN`，未设置时用 WORKER_TOKEN；nginx 不对公网开放 `/internal/`）和 `GET /v1/admin/metrics`（管理员登录态）返回同一份文本。

| 指标 | 说明 |
| --- | --- |
| `pig_http_requests_total{method,route,status}` | 按路由模板和状态类计数 |
| `pig_http_request_duration_seconds{route}` | 延迟直方图（SSE / 长轮询除外） |
| `pig_model_requests_total{status}` / `pig_model_request_duration_seconds` | 网关模型调用（上游状态码，`no_key`、`rejected_*`） |
| `pig_model_failovers_total{recovered}` / `pig_model_output_capped_total` | 故障转移次数、因超出输出上限被截断的流 |
| `pig_storage_ops_total{op,result}` / `pig_storage_fallback_total{kind}` / `pig_storage_blobs{table,location}` | 对象存储读写（put/get/gc_delete × ok/error/missing/mismatch）、回退到 Postgres 原件的读取次数、各表在对象存储与 Postgres 中的数量 |
| `pig_run_execution_seconds{outcome}` | 每次执行尝试耗时 |
| `pig_runs{state}`、`pig_queue_oldest_seconds`、`pig_runners_online` | 队列与 Runner |
| `pig_webhook_deliveries{state}`、`pig_event_bus_live`、`pig_pg_pool_connections{state}` | 依赖健康 |
| `pig_alerts_firing{severity}`、`pig_trace_spans_total{service}`、`pig_telemetry_exporter{stat}`、`pig_process{stat}` | 自身状态 |

外部 Prometheus 的抓取配置和等价告警规则见 `infra/observability/`。

## 告警

cloud 每 30 秒评估一次 10 条内置规则（多实例时用 advisory lock 保证只有一个实例评估），状态写入 `alerts` 表：

| 规则 | 级别 | 条件 |
| --- | --- | --- |
| `runners_offline` | critical | 有启用的 Runner 但 30 秒内都没有心跳，持续 60 秒 |
| `model_provider_errors` | critical | 10 分钟内出现 HTTP 402（余额不足）或至少 3 次错误 |
| `model_failover` | warning | 10 分钟内至少 3 次主渠道失败后切换到备用渠道（见 [model-routing.md](model-routing.md)） |
| `queue_stalled` | warning | 最早排队的任务等待超过 5 分钟 |
| `run_failure_rate` | warning | 30 分钟内结束的任务 ≥ 4 个且失败率 ≥ 50% |
| `http_5xx` | warning | 5 分钟内请求 ≥ 20 个且 5xx ≥ 5% |
| `webhook_dead` | warning | 1 小时内有投递重试 8 次后仍失败 |
| `event_bus_down` | warning | LISTEN 连接断开持续 60 秒 |
| `storage_degraded` | warning | 已启用对象存储但不可达，或有文件待复制，持续 5 分钟（见 [object-storage.md](object-storage.md)） |
| `telemetry_dropping` | info | span 队列满导致丢弃 |

触发和恢复时，会给所有启用的管理员中订阅了 `alert.firing` / `alert.resolved` 的 Webhook 发送签名事件（与任务事件同一套投递、重试、日志）。`GET /v1/admin/alerts` 返回当前和最近的告警及规则；`POST /v1/admin/alerts/test` 只给调用者自己的 Webhook 发送一条测试告警。

## 评测门禁（CI）

- `pnpm eval:context`：上下文工程离线门禁（已有）。
- `pnpm eval:gate`：任务评测回归门禁。用离线场景模型跑 `task-cases`，逐个用例、逐个检查项与 `evals/tasks-mock-baseline.json` 对比：基线通过的用例或检查项失败、用例缺失、模型调用比基线多 1 次以上或工具调用多 2 次以上都会让 CI 失败。改进只提示，确认后用 `pnpm eval:tasks --write-baseline evals/tasks-mock-baseline.json` 更新基线并随 PR 提交。
- `.github/workflows/eval.yml`：真实模型评测，手动触发或每周一次。只有配置了仓库 secret `EVAL_LLM_API_KEY` 时才运行（可选变量 `EVAL_LLM_BASE_URL`、`EVAL_LLM_MODEL`），否则跳过；结果作为 artifact 上传。
