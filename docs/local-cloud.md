# 本地 Docker 云平台：第一批交付

## 当前范围

所有后端依赖都在本机 Docker 中：PostgreSQL、cloud API、模型网关、可信 Worker。Web 云任务页与独立管理后台由 cloud 容器提供静态资源，执行任务使用单独创建的短生命周期容器。

这是平台计划 M0 / M1 的第一个纵向闭环，不是完整多租户产品。当前使用管理员和两个普通账号的本地访问令牌，数据按账号隔离；尚未实现账号注册、组织空间、邀请、模型渠道管理表单、逐项写入审批、容器工作卷跨轮保留、完整云会话同步或公网部署。现有桌面/本地 Web 的 remote 适配器已通过真实平台验证，不等于桌面完整云账号体验已交付。

## 启动

需要已启动的 Docker Desktop、Node 24 和 pnpm 11.19.0。在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm cloud:up
```

首次启动构建镜像并初始化数据库。入口：

- 用户工作台：http://127.0.0.1:8890/cloud
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
- 工作区上传支持现有 remote 适配器的受限归档，云页面支持最多 20 个文本文件。依赖安装、Git 克隆和二进制产物不在本批范围。

现有桌面/本地 Web 可在设置中选择 Cloud / remote，地址填 `http://127.0.0.1:8890`，Cloud token 填普通账号令牌。当前 follow-up 会返回 410，让旧适配器用新本地快照创建下一轮；远程产物不会自动写回本地目录，请从云工作台下载。

## 本批验收

- 未认证 401，普通账号访问后台 403，跨账号任务/事件/下载/取消 404。
- 幂等提交、不同内容复用同请求标识拒绝、路径穿越输入拒绝。
- 真实容器写入和读回、产物下载、事件序号重播。
- 三任务执行、管理员取消和审计、Worker SIGKILL 后租约失败与重新提交恢复、无残留任务容器。
- 现有 Web / Electron remote 适配器上传工作区、SSE 回复及产物元数据通过。

新增 Linux Docker CI 会重复运行这些行为检查，既有 Web / 桌面测试继续保留。

## 下一批

1. 数据库版本化迁移、正式登录/登出、空间和成员权限。
2. 管理后台的用户、模型渠道、凭据管理和配额操作。
3. 云会话多轮、工作卷保留和产物对象存储。
4. 复用完整工作台、桌面云账号切换和显式成果导入。
5. 环境镜像模板、依赖安装网络策略、云端 Codex、部署备份与发布。
