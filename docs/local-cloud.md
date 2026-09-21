# 本地 Docker 云平台：第一批交付

## 当前范围

所有后端依赖都在本机 Docker 中：PostgreSQL、cloud API、模型网关、可信 Worker。开发用执行诊断页与管理后台由 cloud 容器提供静态资源，执行任务使用单独创建的短生命周期容器。

这是平台计划 M0 / M1 的第一个纵向闭环，不是完整多租户产品。当前使用管理员和两个普通账号的本地访问令牌，数据按账号隔离；尚未实现账号注册、组织空间、邀请、模型渠道管理表单、逐项写入审批、容器工作卷跨轮保留、完整云会话同步或公网部署。现有桌面/本地 Web 的 remote 适配器已通过真实平台验证，不等于桌面完整云账号体验已交付。

## 启动

需要已启动的 Docker Desktop、Node 24 和 pnpm 11.19.0。在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm cloud:up
```

首次启动构建镜像并初始化数据库。入口：

- 用户入口：现有 Web / Electron 工作台，在设置中连接 remote。
- 开发诊断页：http://127.0.0.1:8890/debug/runs（不作为独立用户工作台；旧 /cloud 地址兼容跳转）
- 管理后台：http://127.0.0.1:8890/admin/
- 本地访问令牌：`data/cloud-local/access.txt`，仅当前用户可读。

重复启动保留原凭据与数据库。只有 8890 绑定本机回环地址，数据库、网关和 Docker socket 不对浏览器公开。其他本地 Web / Electron 服务无需停止。

```bash
pnpm cloud:status     # 查看服务
pnpm cloud:logs       # 最近 100 行日志
pnpm cloud:smoke      # API + 真实容器 + Worker 崩溃恢复验收
pnpm exec tsx scripts/smoke-cloud-adapter.ts # 现有 Web/桌面 remote 协议联调
pnpm cloud:down       # 停止平台并清理执行容器，保留数据库卷
```

源码有变动后重新执行 `pnpm cloud:up`。不要手动删除数据库卷，除非确实要清除云任务数据。

## 模型

默认 `MODEL_MODE=mock`，没有使用或上传个人 DeepSeek Key。模拟模型固定调用 write_file 和 read_file，真实在容器写入 `cloud-proof.txt` 并读回；它用于验证整条执行链路，不能完成任意自然语言任务。

若要使用真实模型，手动在本机 `data/cloud-local/stack.env` 配置：

```dotenv
MODEL_MODE=provider
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_NAME=deepseek-chat
MODEL_API_KEY=填写自己的平台模型密钥
```

再执行 `pnpm cloud:up`。密钥只交给网关容器，不进入执行镜像或任务快照。该文件和访问令牌都被 Git 忽略；不要把 `docker inspect`、`docker compose config` 的完整输出公开，因为可能包含服务环境变量。

`cloud:smoke` 使用固定模拟响应做断言，运行前应保持 mock 模式；它会强制终止并重新启动 Worker，请在没有个人运行任务时执行。

## 执行和交付

- 单 Worker 提供 3 个并发槽位，每账号最多 5 个活动/排队任务。
- 运行状态：queued → preparing → running → succeeded / failed；取消经过 cancelling → cancelled。
- 每任务容器 1 CPU、512 MiB 内存、128 PID；工作区和临时目录各 64 MiB，约 4 分钟总时限；网关每任务最多 24 次模型请求。
- 非 root、只读根文件系统、移除 capabilities、禁止新增权限；每任务创建独立内部 Docker 网络并连接模型网关，不共用执行网络，不提供任意互联网依赖安装。
- 只有可信 Worker 挂载 Docker socket，Agent 容器不挂载宿主目录、数据库或 socket。普通 Docker 的限制仍适用，当前仅作为本机内测平台。
- PostgreSQL 保存任务、事件、产物和审计；当前产物仅支持文本，每文件最多 200 KB、每任务最多 100 个且总大小约 2 MiB，后续迁移对象存储。
- 任务结束后执行容器及其临时文件回收，已收集的产物可下载。取消/失败任务当前不保证收集部分产物。
- worker 使用短期租约和运行令牌；丢失租约后旧实例不能提交。失联任务标为失败，不自动重跑有副作用的命令。
- 工作区上传支持现有 remote 适配器的受限归档，诊断页支持最多 20 个文本文件。依赖安装、Git 克隆和二进制产物不在本批范围。

现有桌面/本地 Web 可在设置中选择 Cloud / remote，地址填 `http://127.0.0.1:8890`，Cloud token 填普通账号令牌。当前 follow-up 会返回 410，让旧适配器用新本地快照创建下一轮；远程产物不会自动写回本地目录，可在原工作台顶部“远端运行”查看日志、回复并下载成果。

## 本批验收

- 未认证 401，普通账号访问后台 403，跨账号任务/事件/下载/取消 404。
- 幂等提交、不同内容复用同请求标识拒绝、路径穿越输入拒绝。
- 真实容器写入和读回、产物下载、事件序号重播。
- 三任务执行、管理员取消和审计、Worker SIGKILL 后租约失败与重新提交恢复、无残留任务容器。
- 现有 Web / Electron remote 适配器上传工作区、SSE 回复及产物元数据通过。

新增 Linux Docker CI 会重复运行这些行为检查，既有 Web / 桌面测试继续保留。

## 下一批

本批已实现统一执行位置选择与控制面定时调度，下一批：

1. 远端会话多轮、工作区保留与原工作台内成果查看和导入。
2. 正式身份权限、模型渠道、节点容量、资源配额及后台治理。
3. 云端 Codex、部署备份与发布验收。

## 架构修订

以 [最新实施计划](platform-expansion-plan.md) 为准：远端执行和远端定时任务最终均以控制面为权威，Web/Electron 共用同一个工作台。远端计划现由控制面持久化并调度，退出本地服务后仍触发；本地计划保留本地调度。

## 使用远端会话和定时任务

1. Web / Electron 的“设置 → 远端控制面连接”填写 `http://127.0.0.1:8890` 和普通账号令牌，保存。连接设置独立于默认本地模型。
2. 会话顶部“执行位置”选“远端容器”；执行引擎独立选择，远端目前支持 Pig，本地支持 Pig/Codex。执行期间不能切换。
3. “自动化”新建时选择“远端容器 · 控制面调度”，再填写五段 cron 或 `@hourly` / `@daily`、IANA 时区。
4. 错过触发默认跳过（迟到超过一分钟）；也可选择恢复后补跑一次。同一计划不重叠，账号最多 5 个活跃/排队任务；跳过原因可见。
5. 计划留空表示仅手动；停用阻止未来触发，不取消已运行任务。删除计划保留既有运行记录。
6. “远端运行”查看权威状态、日志和成果。关闭窗口不会停止任务；取消请求必须获得控制面确认。后台可以排空节点、设置 1–3 个并发槽位。

远端计划目前仅支持提示词，不隐式上传本地项目、专家或文件。旧 `runtime=cloud` 自动化显示“待迁移”，解除本地绑定后点“迁入控制面”；迁移幂等。普通本地自动化保持原行为。

```bash
pnpm cloud:smoke:schedules                     # 调度、时区、去重、补跑、节点治理和重启
pnpm exec tsx scripts/smoke-cloud-workbench.ts  # 原工作台 API、断流继续与消息恢复
```

调度故障测试会临时排空节点并重启控制面，只允许在无活动任务、无启用定时计划的开发栈运行。时间解析使用 [cron-parser](https://github.com/harrisiirak/cron-parser) 的时区支持，限制为分钟级且禁止同时限定日期与星期。

## 远端会话、账号与资源

在已有 Web / Electron 工作台选择远端执行。每次跟进创建独立 run，复用会话的最近完整工作区快照；同一会话拒绝并行写入，过期客户端必须刷新。工作台「远端运行记录」中点击「在工作台继续会话」，可在另一设备用同一账号恢复会话。打开已恢复的会话会向控制面核验最新一轮。

「下载工作区版本」提供 tar.gz。当前快照保存在 PostgreSQL 持久卷，最多 400 个文件、4 MiB 总输入、单文件 512 KiB；排除 `.env*`、密钥、`.git`、依赖和构建目录。超限或节点硬故障没有完整检查点时，不会静默用旧文件继续。正常失败/取消尽力保存检查点；硬杀无法保证最后的内存工作区。文本成果可生成本地审阅变更单，批准时再次检查本地文件指纹，避免覆盖预览后修改。

管理后台新增：

- 24 小时一次性邀请。用户在工作台设置填写控制面 URL，兑换邀请码；访问会话 30 天有效。管理员可在原账号旁签发「新设备登录 / 续期」邀请，保留同一账号和全部远端历史。
- 禁用账号、撤销登录会话、设置每日模型请求限额（UTC 日界线；请求失败也消耗预留调用）。内置运维令牌仍由 stack.env 管理。
- 创建 HTTPS Chat Completions 模型渠道、测试连接、启用/停用。测试会发起一次最多 8 token 的真实请求。当前最多一个启用渠道，停用全部时回到部署默认模型。模型密钥以 AES-256-GCM 加密，ENCRYPTION_KEY 独立保存在忽略提交的 stack.env；密钥仅传给可信网关，不进入任务容器。
- 轻量（0.5 CPU / 256 MiB / 120 秒）、标准（1 CPU / 512 MiB / 240 秒）、扩展（2 CPU / 1024 MiB / 600 秒）。规格在入队时固定，后台变更只影响新任务；attempt API 保留实际执行规格和节点。

完整验证命令：

```sh
pnpm cloud:up
pnpm cloud:smoke:schedules
pnpm cloud:smoke
pnpm cloud:smoke:conversations
pnpm cloud:smoke:platform
pnpm exec tsx scripts/smoke-cloud-adapter.ts
pnpm exec tsx scripts/smoke-cloud-workbench.ts
pnpm desktop:build
pnpm desktop:smoke
```

调度/故障验收会暂时排空节点、重启控制面或 Worker；请在没有实际任务运行时执行。平台验收创建 10 个隔离账号，结束后禁用账号并撤销会话，保留运行审计。

## 备份与恢复验证

```sh
pnpm cloud:backup
pnpm cloud:restore:verify /absolute/path/to/backup.dump
```

备份写入 `data/cloud-local/backups`，文件权限 0600，并验证 PostgreSQL archive 目录。恢复验证创建临时数据库，完整导入并读取关键表，最后删除临时库，不替换当前数据库。

异机灾备同时保存 dump 和受保护的 `data/cloud-local/stack.env`；缺失 ENCRYPTION_KEY 时无法解密已有模型渠道。生产替换前先暂停新任务、排空 Worker、备份当前库，在独立 PostgreSQL 恢复 dump，设置原密钥并验证后切换 DATABASE_URL。命令不会自动清空现有数据库。

这仍是邀请制内测工作台：尚未提供组织共享项目、远端 Codex、云端工具审批恢复、S3 存储、自动保留期或桌面签名更新。
