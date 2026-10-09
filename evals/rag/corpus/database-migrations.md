# 数据库迁移（版本化）

云端 schema 由 `apps/cloud/src/schema.ts` 中的 `migrations()` 列表管理，`apps/cloud/src/migrations.ts` 负责执行。

## 运行方式

- cloud 启动时自动执行待处理迁移（`migrate()`），之后再按环境变量同步引导账号。
- 全程持有 advisory lock `71839021`（与旧版内联 schema 相同），多个 cloud 实例、新旧版本同时启动也会串行执行。
- 每个迁移和它在 `schema_migrations(version, name, checksum, applied_at)` 里的记录在同一事务中提交；中途失败时，之前的版本保留，之后的版本仍为待处理。
- 已执行迁移的 SQL 若被修改，checksum 不一致，启动会直接失败。
- 数据库版本比当前镜像新（应用回滚）时只打印提示、继续启动，因为每个发布都只做扩展（expand）。

`0001 baseline` 是引入版本化之前的完整 schema，全部是 `IF NOT EXISTS`。在已有数据库上执行时是 no-op，只写入版本记录。`apps/cloud/src/schema.test.ts` 锁定了它的 checksum。

## 新增迁移

1. 在 `migrations()` 末尾追加 `{ version: 下一个整数, name, sql }`。不要修改已发布的迁移，也不要改 baseline 引用的各个 `*Schema` 常量。
2. 遵守 expand → migrate → contract：
   - **本次发布只做扩展**：新表、可空或带默认值的新列（PG 11+ 加带常量默认值的列不重写表）、新索引。上一版本代码必须还能在新 schema 上运行。
   - 数据回填放在单独迁移里，按批执行，避免长事务。
   - **收缩放到下一次发布**：确认线上已没有读取旧列 / 旧表的代码后，再删除或重命名。
3. 大表加索引用 `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`，并设置 `transaction: false`（PG 不允许在事务中执行）。这类迁移必须可以重复执行。
4. 加测试：至少在真实 PostgreSQL 上验证「已有库升级」和「空库初始化」得到相同 schema。

## 部署前检查

镜像构建完成、切换流量之前，用新镜像只读查看待执行的迁移：

```bash
docker compose --env-file data/cloud-local/stack.env \
  -f infra/cloud/compose.yml -f infra/tencent/compose.yml \
  run --rm --no-deps cloud node migrate.mjs status
```

输出示例：

```
applied  0001 baseline  2026-10-09T10:25:52.010Z
pending  0002 add_run_priority
1 pending, 1 applied
```

`node migrate.mjs up` 会立即执行待处理迁移。通常不需要，cloud 启动时会自动执行。

## 回滚

- 只回滚应用镜像（例如 `scripts/deploy/deploy.sh rollback`）。schema 只做了扩展，旧代码可以继续运行；旧版本启动时执行的内联 `IF NOT EXISTS` schema 也与新库兼容。
- `0003 webhooks` 回滚后：触发器仍会为已登记的 Webhook 写入投递记录，但旧版本没有分发器，这些记录只会累积、不会发送；重新部署新版本后会按到期时间补发。
- `0004 observability` 回滚后：`trace_spans` / `alerts` 两张表留着不用，旧版本不读写它们；重新部署新版本后接着写。保留期（默认 7 天）的清理也由新版本负责，回滚期间数据不会增长。
- `0005 model_routing` 回滚后：主渠道仍是唯一启用的渠道，旧版本照常使用；备用顺序和输出上限两列会被忽略，旧版本按固定 4096 输出上限工作，不做故障转移。
- `0006 storage` 回滚后：`dual` 模式下附件与工作区快照的原件仍完整保存在 Postgres，旧版本直接读取，对象存储中的副本被忽略（MinIO 容器可保留或停止）。若已切到 `object` 模式，回滚前需先把对象回填到 Postgres——因此 `object` 模式须单独审批后再启用。
- 不要手工删除 `schema_migrations` 里的行。确实需要撤销时，写一个新的迁移来撤销。
