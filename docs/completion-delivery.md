# 完成交付与节点代次（F1 / F3）

## 行为

Runner 将执行结果与结果交付分开处理。容器产生的原始完成消息会先写入私有 outbox（文件 0600、目录 0700），文件 fsync 后原子重命名并同步目录，再提交控制面。临时网络错误与 5xx 不会改写成执行失败；相同提交最多连续尝试 6 次，保留未确认消息并每 30 秒恢复交付。节点启动在注册新代次前先恢复已有消息。

控制面在同一数据库事务中锁住任务、验证尝试凭据及租约、保存状态/成果/检查点和完成收据。确认丢失后，同一 submissionId、凭据和内容重放返回原终态；内容不同或凭据错误返回 409。取消和完成通过任务行锁顺序决定终态，完成重放不会逆转取消；已存在的成果不会重复插入。

节点注册历史由 `worker_generations` 保存。当前代次重放注册是幂等的；已经被替代的代次永久拒绝，不再使新代次任务失败。并发新代次按数据库锁的顺序确定最后接任者，不假设客户端 UUID 有时间顺序。

## 持久化与排障

两个 Compose 配置均挂载 `worker-outbox` 命名卷。默认目录 `/app/data/worker-outbox/<cluster>/<workerId>`；自定义部署可以用 `WORKER_OUTBOX_DIR` 指定持久目录。目录含尝试凭据及任务成果，不应公开、提交 Git 或作为普通日志上传。

- `.json`：尚未确认，后台和下次启动会重试。
- `.json.corrupt`：无法解析的持久文件，保留供排查，不阻塞其他完成消息。
- `.json.rejected`：控制面明确拒绝（例如租约已失效或节点已被替代），保留原内容供授权管理员核验；不会自动复活任务或重跑副作用。
- 出现 `Completion persistence/delivery unavailable`：检查磁盘容量和目录权限；持久写入未确认时本进程不会删除执行容器。

长期控制面不可用超过租约后，任务仍按原有边界失败，原始成果保留在 Runner outbox，不会绕过失效凭据写回终态。该文件系统卷是单 Docker 主机持久化，不是跨主机复制存储。宿主磁盘损坏、尚未持久写入时进程崩溃不属于本次交付保证；这不是 exactly-once 执行。

## 可复现验证

仅在没有活动任务的独立 mock 集群运行；脚本会暂时停用其他 Runner 并在 finally 恢复配置。不得对用户真实模型平台运行。

```sh
pnpm cluster:up
node scripts/smoke-cluster-migration.mjs
node scripts/smoke-completion-fencing.mjs
node scripts/smoke-completion-delivery.mjs
pnpm exec vitest run apps/worker/src/completion-outbox.test.ts
```

`smoke-cluster-migration` 在真实 PostgreSQL 的独立 schema 中运行首次和重复迁移、旧节点代次回填，最后回滚，不修改当前集群数据。

`smoke-completion-fencing` 轮流访问两个控制面，验证重复及并发完成只写一份成果、内容冲突/错误凭据拒绝、取消竞争、迟到注册不能挤掉持有活动任务的新代次、并发注册后旧代次不可返回。

`smoke-completion-delivery` 启动真实 Runner 与 Docker mock 执行容器，通过故障代理分别注入首次提交前 503 和提交成功后关闭响应连接。正常对照与两种故障均必须成功，只有一个成果，下载文本精确匹配 `PIG_CLOUD_CONTAINER_OK`。macOS 下 socket shim 只映射当前 Docker context 的 socket，不修改执行行为。

脱敏 JSON 输出位于 `data/acceptance-redesign/completion-fencing.json` 和 `finish-fault.json`。单元测试另外验证 outbox 文件权限、重试内容不变、进程重启后的恢复及失效结果保留。
