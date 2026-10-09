# 对象存储（U5）

附件（`attachments`）和工作区快照（`workspace_versions.snapshot.data`，tar.gz）存放在 S3 兼容对象存储中。默认部署为 compose 内的 MinIO，只接入内部网络 `storage`（仅 cloud 与 minio，`internal: true`，无公网端口、无控制台）。代码仅依赖 S3 API（SigV4、path-style，见 `apps/cloud/src/object-store.ts`），可通过 `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY/S3_REGION` 切换到腾讯云 COS、Garage 或 AWS S3。

## 模式（`STORAGE_MODE`）

| 模式 | 写入 | 读取 | 回滚 |
|---|---|---|---|
| `pg`（未设 `S3_ENDPOINT` 时） | 仅 Postgres | Postgres | — |
| `dual`（默认） | Postgres 原件 + 提交后复制到对象存储，回读并校验 SHA-256 后才记录 `blob_key/blob_sha256` | 优先已校验的对象；缺失/损坏/不可用时回退 Postgres 原件（`pig_storage_fallback_total`） | 安全：原件全在 Postgres |
| `object`（需审批） | 先写对象并校验，再插入行（Postgres 不存字节）；对象存储不可用时附件上传返回 503，快照回退写 Postgres | 对象；仍有原件的旧行可回退 | 需先回填 |

**Postgres 原件不会被本模块删除。** 清理 Postgres 中已校验原件（`UPDATE … SET data=NULL`）属破坏性操作，需单独审批后人工执行。

## 迁移已有数据：先复制、再校验

- 启动时及每小时：`backfill` 把尚未复制的行（`blob_key IS NULL`）逐个复制 → 回读 → 校验 SHA-256 → 记录。失败的行保持待复制，下次重试。
- `GET /v1/admin/storage`：模式、可达性，以及每张表的 total / offloaded / verified / inPostgres / pending。
- `POST /v1/admin/storage/backfill {limit}`：立即复制一批。
- `POST /v1/admin/storage/verify`：重新读取每个对象，对比记录的摘要和 Postgres 原件，返回 missing / mismatched 列表并刷新 `blob_verified_at`。

## 清理

- 用户删除附件时，同时尽力删除对应对象。
- 告警 `storage_degraded`（内置）与 `PigStorageFallback`（Prometheus）覆盖对象存储不可达、复制积压与回退读取。
- 每小时孤儿回收：对象键在数据库中已无对应行、且创建超过 24 小时才删除（宽限期覆盖“已写对象、尚未记录”的进行中复制）。

## 镜像与内存

- 镜像默认 `cgr.dev/chainguard/minio`（按 digest 固定）：从 MinIO 源码构建并持续修补。MinIO 社区版自 2025-10 起只发布源码，Docker Hub 上的 `minio/minio` 已不可用（2026-10 返回 404），其最后官方镜像 `RELEASE.2025-09-07T16-13-09Z` 不含 2025-10-15 之后的安全修复。可用 `MINIO_IMAGE` 覆盖。
- 腾讯单机：minio `mem_limit 256m`、`GOMEMLIMIT=200MiB`；postgres、cloud 由 512m 下调到 448m（实测各自 < 70 MiB）。上限合计 3392 MiB ≤ 3.4 GB。
- 凭据：`MINIO_ROOT_USER/MINIO_ROOT_PASSWORD` 在缺失时由 `deploy.sh`（服务器）或 `pnpm cloud:setup`（本地）随机生成并写入 `stack.env`（0600，不打印）。cloud 默认以同一凭据访问。
