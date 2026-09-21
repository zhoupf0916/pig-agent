# 本地双控制面与双 Runner 验证环境

这是可复现的单机多进程/多容器验证环境，不代表数据库、网关或宿主机具备高可用性。用户已有的 `pig-agent-cloud`、8890 与数据卷保持独立。新环境使用 mock 模型，不消耗用户模型额度。

```sh
pnpm install --frozen-lockfile
pnpm cluster:up
pnpm cluster:status
pnpm cluster:smoke
pnpm product:smoke
pnpm cluster:logs
pnpm cluster:down
```

需要 Node 24、pnpm 11.19、已启动的 Docker Desktop。首次构建需下载镜像。Docker Desktop 中项目名为 `pig-agent-cluster`。

产品验收默认使用系统 Chrome，自动在空闲的8798端口启动隔离工作台并在完成后关闭。无 Chrome 时先运行 `pnpm exec playwright install --with-deps chromium`，再运行 `PIG_BROWSER_CHANNEL=chromium pnpm product:smoke`。保留8798空闲；不要将故障脚本改指用户已有的8890环境。

- `http://127.0.0.1:8892/admin/`：负载均衡入口与管理后台。
- `8893` / `8894`：仅绑定本机的控制面 A/B 直连端口，用于故障和一致性验证。
- `cloud-a`、`cloud-b` 共享 PostgreSQL；两者都运行调度 tick，数据库锁和唯一键协调。
- `runner-a`、`runner-b` 各报告两个执行槽位，通过控制面领取任务。
- `gateway` 为执行容器代理模型，容器只获得一次运行的可失效令牌。
- 凭据独立生成于忽略提交的 `data/cluster-local/stack.env`（0600）；管理员使用其中 ADMIN_TOKEN 登录。不要把该文件发到聊天或提交仓库。

在工作台设置中填写控制面地址 `http://127.0.0.1:8892` 与此环境的 MEMBER_TOKEN 即可使用。它与原 8890 的账号、任务、模型和数据互不相通。停止集群保留数据库卷。

## 执行语义与边界

任务提交用账号内的幂等请求键去重；领取由 PostgreSQL 短事务锁串行协调，全局、用户、项目和节点容量在同一领取事务检查。用户之间按最近一次领取时间轮转，同一用户内按入队时间选择。队列总量超过策略时返回 429，排队超过期限标失败。降低容量不会杀死已运行任务，而是停止新增领取直到低于新上限。

每个 Runner 使用稳定 WORKER_ID（默认 hostname）和每次启动的新 instanceId。新启动代次隔离旧进程，旧令牌不能提交事件或完成状态。节点周期性心跳独立于任务，后台以 15 秒阈值显示离线；运行租约为 20 秒，心跳约每 2 秒更新，数据库 deadline 不能被续租无限延长。能力目前是支持的资源规格，而不是任意插件发现。

事件携带稳定 eventId，传输重试不会重复插入。数据库事件游标支持跨控制面补播；断开网页不会取消任务。暂不持久化逐 token 文本，只保留完整消息和工具事件。

系统**不保证 exactly-once 外部副作用**。任务运行后遇到节点失联，控制面将其标为失败；不会自动重放文件、网络或命令副作用。用户应核验已有成果后手动发起下一次运行。审批授权只领取一次，领取后掉线也不会再次授权旧操作。

SIGTERM 让 Runner 停止领取并等待在途任务，默认 25 秒后停止仍在执行的容器并上报失败；Compose 给 40 秒退出期限。进程崩溃遗留资源在同一稳定节点重新启动时回收。宿主机永久失联时，控制面不能远程清理其 Docker 资源；恢复节点后才能清理。Agent 自身还有独立运行时限。

## 配置与生效范围

后台「执行与模型」中的全局/用户/项目并发、队列上限和等待期限在数据库持久化，对所有控制面生效。节点「调度容量」是管理员上限；Runner 报告的容量是硬件/进程上限，实际使用二者较小值，重启不覆盖管理员策略。资源规格在提交时固定，影响新任务的 CPU、内存、PID 和运行时长。

现有账号最多保留5个未结束任务，因此用户执行并发的可配置范围是1–5；它控制执行数量，账号未结束任务额度同时计入排队任务，两者分别校验。

Runner 环境：`WORKER_ID`、`WORKER_CAPACITY`（1–16）、`WORKER_PROFILES`（compact,standard,large）、`WORKER_SHUTDOWN_SECONDS`、`CONTROL_URL`、`GATEWAY_CONTAINER`、`RUNNER_IMAGE`。不同节点必须使用不同稳定 ID。同一 Docker daemon 上的网关容器名称通过配置指定，不再写死。

`WORKER_NAMESPACE` 标记资源所属集群，独立验证环境使用独立命名空间。`cluster:down` 只清理该集群的执行容器和网络，保留数据库卷及原8890平台资源。

跨主机部署时，每台 Runner 主机需要其可达的网关容器和执行镜像。当前共享 WORKER_TOKEN 将节点视为可信基础设施，未实现逐节点证书、自动扩缩容、数据库复制或公网 TLS。Docker socket 仅挂到可信 Worker，不挂到 Agent。不得将本地验证配置直接当作公网部署方案。

## 排障

- 有排队但无运行：检查节点 online/enabled/draining、能力规格及全局/用户/项目限额。
- Runner 报 409：启动代次已经过期，检查是否复用了 WORKER_ID；旧节点不得自行反复注册抢占新节点。
- 日志暂时中断：检查控制面/入口健康，客户端使用游标重连；不要把断流等同任务失败。
- failed 且提示节点失联：先核验产物与外部副作用，不自动再次执行。
- Docker 只见常驻节点：`pig-run_…` 执行容器按任务创建并在任务结束回收。

验证结果和剩余问题持续记入 [产品化工作记录](productization-worklog.md)。本地测试只说明测试环境中的行为，不推断生产吞吐或高可用。

### 网络与代理恢复

控制网络为 Docker 内部网络，PostgreSQL、Runner 和 Gateway 不依赖宿主机外网。两个控制面另接 `egress` 网络供模型提供商访问；入口代理另接 `ingress` 网络发布本机 8892 端口。代理保留 Docker 服务发现，但其外部 DNS 后备指向容器回环地址：停止的服务名不能被宿主机通配 DNS / fake-IP 代理解析为外部地址。没有为 POST 打开无条件重放。

Nginx 使用目录挂载读取 `/etc/pig-cluster/nginx.conf`，避免编辑器原子替换单文件后 Docker 挂载保留失效 inode。`cluster:up` 会检查并重载代理配置，并实际请求宿主机 8892 健康端点，不能仅凭容器 Healthy 宣布可用。

从旧的非内部控制网络升级，先在没有活动任务时运行 `pnpm cluster:down`，再执行 `pnpm cluster:up`。这两个命令不会删除 PostgreSQL 或 Runner outbox 命名卷。若入口 502，查看 `pnpm cluster:logs control`；若日志中的控制面上游出现 198.18 等宿主机 fake-IP 地址，检查入口服务的 DNS 配置是否被覆盖，而不是给所有 POST 添加盲目重试。


2026-09-22 的修复回归实际运行于本机 Docker Desktop：两个控制面、两个 Runner（各两个槽位），模型为确定性 mock。严格协议验证 14 项全部通过；真实 Runner 故障套件耗时 59,140 ms，验证四任务四容器并发、SIGKILL 后不重放、剩余 Runner 与单控制面完成任务、SIGTERM 有界退出和执行资源零残留。之后顺序通过空数据库迁移/重复迁移/历史代次回填、五项完成与代次隔离验证、三项真实容器完成交付验证（正常、提交前 503、提交后丢响应）。这不是生产容量测量，也不证明整套系统高可用。

首次严格故障回归曾在控制面退出后的审批 POST 返回 502；该失败及 DNS 修复摘要保留于 `data/acceptance-redesign/cluster-dns.json`。原始集群结果位于 `data/cluster-local/evidence/control.json` 和 `runners.json`；交付及代次验证见完成交付文档与重设计验收证据。故障修复没有降低原有测试标准或允许盲目重放非幂等请求。
