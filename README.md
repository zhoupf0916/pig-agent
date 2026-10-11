# Pig Agent

交代一个任务，它在云端沙箱或这台电脑上做完。你批准写入、核对成果，然后继续。

浏览器打开即可使用，不必安装本机服务。桌面版可以在本机执行，也可以加入同一个云端项目。

开发与技术复盘请阅读 [技术实现与亮点手册](docs/technical-handbook.md)：覆盖全项目模块，深入解释上下文管理、记忆保鲜、评测体系、故障恢复与观测，包含源码入口、设计取舍、复现命令、验证证据和面试讲解。

## 亮点

- **对话即任务**：从一句话开始。项目收纳对话和文件，技能、专家和权限在输入栏里选择。
- **先看再写**：写入和命令可以在执行前审批。拒绝或取消后，后续操作不会继续。
- **沙箱执行**：云端任务跑在 Runner 的原生进程里，不为每个任务另起 Docker 容器。本机任务默认使用操作系统沙箱。
- **协作**：申请账号后由管理员批准。项目可以仅自己可见，或与组织成员共享。私人记忆不会带进共享任务。
- **账号预算**：新账号默认一次性 2 元平台模型预算，按 token 用量结算，调用前预留并拦截超额；管理员可修改总预算与每日调用上限。
- **离开也能跑**：定时任务由控制面调度。关闭网页后，云端任务仍会继续，回来可以接着看。
- **扩展与 MCP**：内置编码质量、文档写作、数据分析、资料研究、故障排查五个基础包，以及创意构思、排期、体验研究、趣味交互、分镜和小游戏六个[社区精选包](docs/curated-skills.md)，另有 API 契约体检、发布就绪检查、CSV 数据质量、会议行动整理四个[实用工作包](docs/practical-market.md)，配备中文专家、Python 脚本、参考资料与交付模板；可连接 Streamable HTTP MCP 工具，每次外部调用单独审批。

## 选择使用方式

| 方式 | 执行位置 | 适合场景 |
| --- | --- | --- |
| Web 工作台 | 控制面调度远端 Runner | 浏览器使用、项目协同、持续运行的自动化 |
| Electron 客户端 | 本机工作区，也可连接远端 | 本地代码与文件任务、原生目录选择、桌面操作 |
| 本机 Web 开发模式 | 当前电脑的本机沙箱 | 调试桌面工作台与本机 API；仅供本地开发 |

### 准备开发环境

需要 Node.js **22.13+**（建议 24）、pnpm **11.19.0**。以下命令均在仓库根目录执行。构建本机文件助手需要 C 编译器；macOS 桌面构建需要 Xcode Command Line Tools（`xcode-select --install`）。Linux 本机沙箱需要 Bubblewrap。当前桌面发行目标为 macOS。

```bash
npm install -g pnpm@11.19.0
pnpm install --frozen-lockfile
```

### 本地启动 Web 与管理后台

先启动 Docker Desktop（Linux 可使用 Docker Engine 与 Compose），然后运行：

```bash
pnpm cloud:up

# 首次生成管理员密码；写入 data/cloud-local/accounts.txt，不重置已有账号
node scripts/setup-admin-password.mjs
```

| 入口 | 地址 |
| --- | --- |
| Web 工作台 | http://127.0.0.1:8890/ |
| 管理后台 | http://127.0.0.1:8890/admin/ |

这会在本地启动 PostgreSQL、MinIO 对象存储、控制面、模型网关和 Runner。浏览器本身不执行主机命令。首次使用在工作台申请账号，由管理员批准后登录。默认使用模拟模型；管理员配置并启用真实模型渠道后，任务才会调用真实模型。

```bash
pnpm cloud:status    # 查看服务状态
pnpm cloud:logs      # 查看服务日志
pnpm cloud:down      # 停止服务，保留数据库

# 开发 Web 界面：保持上述平台运行，再在另一个终端启动
pnpm dev             # http://127.0.0.1:5173/，云接口代理到 8890
```

### 本机 Web 开发模式（本机 Agent API）

默认的 `pnpm start` / `pnpm dev:server` 只暴露 Web 入口：所有 `/api/*` 返回 410，并把页面重定向到控制面。调试本机 Agent 需显式开启本机工作台：

```bash
pnpm mock:llm   # 可选：离线 mock 模型，http://127.0.0.1:8788/v1

PIG_LOCAL_WORKBENCH=1 WORKSPACE_ROOT=$(mktemp -d) \
LLM_BASE_URL=http://127.0.0.1:8788/v1 LLM_API_KEY=mock \
pnpm dev        # API http://127.0.0.1:8787，UI http://127.0.0.1:5173
```

`WORKSPACE_ROOT` 默认是仓库内的 `sample-workspace/`，建议指向临时目录以免改动仓库。mock 模型按指令路由场景（列出/读/写/运行命令/闲聊/失败），也可用 `MOCK_LLM_SCENARIO=readme` 或消息里的 `[mock:shell]` 强制指定。`PIG_LOCAL_WORKBENCH=1` 会直接操作本机工作区文件，仅用于本地开发，不要在公网暴露。

### Agent 运行参数（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PIG_MAX_TURNS` | 20 | 每轮最多模型/工具回合（1–200） |
| `PIG_COMPACTION` / `PIG_COMPACT_RATIO` | on / 0.6 | 可见上下文超过预算比例时，用一次模型调用生成分段摘要替换较早消息（原文保留，可 recall_context） |
| `PIG_SUBAGENTS` | on | 只读子 Agent 工具 `spawn_subagent`（全新上下文，最多并行 3 个，只回传报告） |
| `PIG_SKILL_AUTOLOAD` | off | 关闭时关键词命中的技能只做提示，由模型 `load_skill` 按需加载 |
| `PIG_EMBEDDING_BASE_URL` / `PIG_EMBEDDING_MODEL` / `PIG_EMBEDDING_API_KEY` | 未设置 | 设置后记忆召回在 BM25 之外融合向量相似度（OpenAI 兼容 /embeddings） |
| `PIG_ROUTER_FAST_MODEL` / `PIG_ROUTER_STRONG_MODEL` | 未设置 | 按难度路由模型：每个用户回合判定一次（缓存按模型隔离，回合内不来回切换），工具失败或上下文过长时只升级不降级；路由记录在 trace 的 `route` / `pig.route` |
| `PIG_TOOL_SEARCH` / `PIG_TOOL_SEARCH_THRESHOLD` | auto / 12 | MCP 工具超过阈值时只暴露 `search_tools`，模型按意图检索后激活（会话内保持，工具前缀稳定）；`on` 总是启用，`off` 关闭 |
| `PIG_COMPUTER_MAX_ACTIONS` / `PIG_COMPUTER_MAX_OBSERVES` | 25 / 40 | 每次任务电脑操作预算；另有连续失败熔断、疑似密钥输入与终端破坏性命令拒绝、风险提示进入桌面确认框 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `_TRACES_ENDPOINT`）/ `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_SERVICE_NAME` | 未设置 | 以 OTLP/HTTP JSON 导出调试 span（GenAI 语义约定：`chat <model>`、`execute_tool <name>`、token 与缓存命中属性），只导出元数据不导出内容；`OTEL_SDK_DISABLED=true` 关闭 |

远端 MCP 凭据（本机与云端）除静态 Bearer 外，可填 JSON：`{"type":"oauth_client_credentials","clientId":"…","clientSecret":"…","scope":"…"}`，按 MCP 授权规范（RFC 9728 → RFC 8414）自动发现 token 端点（也可显式给 `tokenUrl`），令牌缓存到过期前，401 时刷新一次。云端的元数据/令牌请求与 MCP 流量走同一租户出网策略（私网地址需逐个 URL 加入 `MCP_ENDPOINT_ALLOWLIST`）。

云端 A2A：`GET /.well-known/agent-card.json`（公开 Agent Card），`POST /v1/a2a`（JSON-RPC，Bearer 认证）支持 `message/send`（`configuration.blocking`、`contextId` 续接同一会话）、`message/stream` 与 `tasks/resubscribe`（SSE：`status-update` 进度/工具调用/待审批 `input-required`、`artifact-update` 按模型回合流式输出文本并在结束时附上产物文件，最后一条 `final: true` 的状态带最终回复）、`tasks/get`、`tasks/cancel`；Task 即云端 run，`messageId` 作为幂等键。

任务级评测：`pnpm eval:tasks`（离线 mock）或 `pnpm eval:tasks --real`（使用 `LLM_*`/`DEEPSEEK_API_KEY`），加 `--judge` 用 LLM 评审按每个用例的 rubric 打 1–5 分（`PIG_JUDGE_MODEL` 等可单独指定），并报告评审与确定性检查的一致率；结果写入 `data/evals/`。

### 本地启动 Electron 客户端

```bash
pnpm desktop:dev     # 构建并打开桌面应用，自动启动内置本机服务
```

不需要先运行 `pnpm dev` 或 `pnpm cloud:up`。进入设置后：

1. 在模型设置填写接口地址、模型名称和自己的 API Key，保存并测试连接。
2. 将默认执行环境设为「本机 Pig」。
3. 在工作区设置选择本机文件夹，或为项目配置自己的工作区。
4. 创建任务，按需要逐项批准文件写入、命令或网络请求，再查看成果。

**本机执行会操作所选工作区中的真实文件**，使用操作系统沙箱与审批机制；不需要为每个任务启动 Docker。桌面密钥使用系统加密存储，应用不会自动读取仓库 `.env` 或继承终端里的模型密钥。需要远端执行时，再配置控制面连接。关闭应用会停止本机服务和本机自动化，远端任务由控制面继续管理。

```bash
pnpm desktop:build  # 仅构建桌面运行资源
pnpm desktop:pack   # 生成可直接打开的 macOS .app
pnpm desktop:dist   # 生成 macOS DMG / ZIP
```

打包产物位于 `release/`。安装包自带运行时，使用者无需安装 Node.js 或 pnpm；当前包未签名、未公证。原生目录选择、Computer Use 的系统授权、数据位置与诊断见 [桌面客户端说明](docs/desktop.md)。

### 只在浏览器调试本机执行

```bash
pnpm build
PIG_LOCAL_WORKBENCH=1 pnpm dev
# 浏览器 http://127.0.0.1:5173/，本机 API http://127.0.0.1:8787/
```

这是显式启用的本机开发入口，与默认 Web 云工作台不同。浏览器没有 Electron 原生目录选择器，工作区路径在设置中填写。不要将这个本机开发服务暴露到公网。

## 项目结构

```text
apps/
  web/          React 工作台；Web 与桌面复用界面
  desktop/      Electron 主进程、原生目录选择、系统凭据与打包图标
  server/       本机 API、Agent 执行循环、工具、沙箱及远端适配
  cloud/        控制面、账号权限、任务调度、模型网关与预算
  worker/       Runner 注册、心跳、任务领取与执行资源管理
  admin/        管理后台：账号审批、模型渠道、Runner 与配额
packages/
  contracts/    各应用共享的 API、事件与云协议类型
  design/       共享设计样式与基础资源
infra/
  cloud/        本地 Docker 平台配置（PostgreSQL、MinIO、控制面、网关、Runner）
  cluster/      多控制面、多 Runner 本地验证与 Nginx 负载均衡
  observability/ Prometheus 抓取配置与告警规则
  recovery/     Runner 故障恢复验收环境
  tencent/      腾讯云单机部署、内存上限、HTTPS、限流、证书续期与备份配置
scripts/        构建、启动、冒烟验证与运维脚本
  deploy/       服务器部署、回滚、源码打包、证书检查与线上 e2e
skills/         内置技能
docs/          架构、部署、验收与排障文档
```

`data/` 为本机开发数据，`desktop-dist/`、`cloud-dist/` 和 `release/` 为生成物，不提交 Git。Web、server、cloud 通过 `packages/contracts` 共享协议，不互相导入应用源码。

## 开发验证

```bash
pnpm check:architecture
pnpm typecheck
pnpm test
pnpm build

# 已启动本地 Docker 平台后，使用模拟模型检查云端流程
pnpm cloud:smoke
pnpm cloud:smoke:approvals       # 另有 :schedules :conversations :platform :collaboration
pnpm cloud:smoke:parallel        # 并行子任务：扇出、等待让槽、无效 JSON 重试、级联取消
pnpm cloud:smoke:feishu          # 飞书机器人：假飞书传输 + 真实控制面
pnpm product:smoke               # 构建后跑端到端产品流程（Playwright）

pnpm eval:gate                   # 任务评测对照 mock 基线，回归即失败
pnpm eval:rag                    # 知识库检索评测，recall@5 低于 0.9 即失败
```

多控制面、多 Runner 的本地验证使用 `pnpm cluster:up` 和 `pnpm cluster:smoke`；详细环境与限制见 [本地云平台](docs/local-cloud.md)。

## 云端平台能力

| 能力 | 要点 | 详细说明 |
| --- | --- | --- |
| Token 计量与预算 | 网关解析每次模型调用的输入、缓存命中、输出 token，按调用时的价目快照结算（默认每百万 token：输入 ¥2、缓存命中 ¥0.04、输出 ¥8）；调用前预留，超额拦截 | [云端能力](docs/cloud-capabilities.md) |
| 模拟模型 | `MODEL_MODE=mock`（默认）时网关返回确定性场景：写文件 + 读回 + 审批、联网（`[NETWORK_ACCEPTANCE:<url>]`）、MCP（`[MCP_ACCEPTANCE:echo|write_marker|slow]`）、并行子任务（`[PARALLEL_ACCEPTANCE]`）；`PIG_MOCK_MODEL_DELAY_MS` 调节延迟 | [本地云平台](docs/local-cloud.md) |
| OTel 追踪 | cloud / worker / runner / gateway 共用 trace，GenAI 语义约定 span；`GET /v1/runs/:id/trace` 查看，`OTEL_EXPORTER_OTLP_*` 导出 | [观测](docs/observability.md) |
| Prometheus 指标与告警 | `/internal/metrics`（`METRICS_TOKEN` 或 Worker 令牌）与 `/v1/admin/metrics`；11 条内置告警（Runner 离线、任务失败率、队列停滞、死信、模型上游错误、渠道切换、存储降级、事件总线断开、Webhook 失效、遥测丢弃、测试告警），以 `alert.firing` 推送到 Webhook | [观测](docs/observability.md)、`infra/observability/` |
| 模型路由与故障切换 | 渠道主备、输出上限 `MODEL_MAX_OUTPUT_TOKENS`、熔断（`MODEL_BREAKER_THRESHOLD` / `MODEL_BREAKER_OPEN_MS`）、首包超时 `MODEL_HEADERS_TIMEOUT_MS`；本机运行时另有难度路由 `PIG_ROUTER_*` | [模型路由](docs/model-routing.md) |
| A2A | Agent Card、`message/send`、`message/stream`（SSE）、`tasks/get`、`tasks/cancel`，见上文 | — |
| MCP 按需检索与 OAuth | 工具超过阈值只暴露 `search_tools`；client_credentials 自动发现 token 端点 | [扩展与 MCP](docs/ecosystem-mcp.md) |
| 事件总线 | PostgreSQL LISTEN/NOTIFY 推送任务事件与审批变化，SSE 不再轮询数据库 | [事件总线](docs/event-bus.md) |
| 任务队列 | 按账号轮转领取（`QUEUE_CLAIM=fair`，`legacy` 可回退）；未开始执行的失败按退避重试，不能安全重试的进入死信，管理后台可重放 | [队列](docs/queue.md) |
| 执行并发 | 管理后台或 `PUT /v1/admin/execution-policy` 设置全局 / 账号 / 项目并发、队列长度与排队超时 | [集群](docs/cluster.md) |
| 版本化迁移 | `schema_migrations` 记录版本与校验和，启动自动执行，只做扩展；`node migrate.mjs status` / `up` | [数据库迁移](docs/database-migrations.md) |
| 对象存储 | MinIO（S3 兼容）双写：附件与工作区快照复制、读回校验 SHA-256 后记录；读取优先对象存储、失败回退 PostgreSQL；`STORAGE_MODE=pg / dual / object` | [对象存储](docs/object-storage.md) |
| 知识库 | 项目文档切块，BM25（中文双字切分）+ 可选向量（`EMBEDDINGS_*`）按 RRF 融合；`knowledge_search` 工具，回答带可点击引用 | [知识库](docs/knowledge-base.md) |
| 并行子任务 | `spawn_parallel` 把多项独立工作拆成子任务，父任务让出 Runner 槽位、按 JSON Schema 校验结果后续跑；只在每项工作量较大时使用 | [并行子任务](docs/parallel.md) |
| Webhook 与 OpenAPI | 任务事件与告警以 HMAC-SHA256 签名推送，失败重试、投递记录可重投，SSRF 防护；`/openapi.json` 与 `/api-docs` | [Webhook](docs/webhooks.md) |
| PWA | 可安装、离线外壳、新版本提示、后台标签页完成/审批通知；不缓存 API 与登录 | [PWA](docs/pwa.md) |
| 登录与令牌 | Web 会话 12 小时；引导令牌按 `BOOTSTRAP_TOKEN_TTL_HOURS` 过期，管理员可吊销访问令牌与会话；登录按 IP 和账号限流（失败过多锁定 15 分钟） | [账号与密码](docs/password-account-access.md) |
| 飞书机器人 | 默认关闭；设置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 后以长连接接入，`/bind` 一次性绑定码绑定账号，私聊或群里 @ 触发任务 | [飞书](docs/feishu.md) |

## 部署与运维

单机部署（Docker Compose + 宿主 Nginx HTTPS）见 [腾讯云单机部署](docs/tencent-deployment.md)：各服务内存上限、Nginx 限流（API 10 次/秒、登录 5 次/分钟，按 IP）、安全响应头、IP 证书续期与每日备份。

```bash
bash scripts/deploy/pack-source.sh <commit> /tmp/pack   # 打包源码并生成 .sha256，上传到服务器
bash deploy.sh <commit> --source-tar <file.tgz>          # 服务器上：备份 → 构建 → 切换 → 健康检查
bash deploy.sh rollback                                  # 回到上一个 release（不恢复数据库）
PIG_BASE=https://<host> bash scripts/deploy/e2e-remote.sh   # 线上 e2e（只登录一次，结束注销）
```

完整说明见 [部署脚本](scripts/deploy/README.md)。

## 实测指标

只列在本仓库环境中实际测得的数字；测法与条件见各功能文档。

| 指标 | 之前 | 之后 |
| --- | --- | --- |
| 模型提示缓存命中率 | 77.5% | 85.1% |
| 任务事件推送延迟 p95 | 483 ms | 33 ms |
| 队列领取吞吐 | 11 次/秒 | 91 次/秒 |
| 知识库检索 top-1 命中率 | 60% | 95% |
| 单元测试数 | 986 | 1197 |
| 线上 e2e 检查项 | 16 | 34 |

## 上下文工程与评测

长对话使用有来源的目标、纠正、计划与证据摘录；完整转录保持不变。Pig 运行时可通过 `recall_context` 按消息 ID 分页查阅原文，避免因输出截断重复执行工具。历史证据不替代审批或当前文件状态核验。

```bash
pnpm eval:context                 # 离线新旧策略对照，不调用模型
pnpm eval:context --trials 10     # 重复组装测量，报告写入 data/evals/
```

[设计、权威参考、验收结果与面试讲述](docs/context-engineering-v2.md)。字符预算不等于模型 token 窗口；离线证据保留率不等于模型任务成功率，真实模型评测需显式配置独立环境变量。

## 云端恢复与耗时诊断

控制面保存消息与工作区安全检查点。Runner 失联后最多自动接续两次，保留原截止时间和模型预算；执行中或审批中的不确定操作停止，不自动重复副作用。开发者面板展示排队、准备、模型、工具、审批和恢复次数，缺失数据明确标注。

[设计、实际进程故障验收、桌面/手机截图与复现命令](docs/recovery-observability-2026-09-26.md)。这是安全边界上的恢复机制，不是任意外部操作的 exactly-once 保证。

## 注意事项

- Web 任务固定在云端沙箱。桌面任务可以选择这台电脑，或加入云端项目。
- 新建项目时导入的文件夹是一份初始副本，不会持续同步本机目录。共享项目里，每个会话保留自己的文件版本。
- 网络默认逐次审批；HTTPS 读取或 MCP 调用只批准当前请求，不会放开沙箱任意联网。MCP 在外部服务执行，不属于本机或 Runner 的沙箱。
- 审批最多等待 30 分钟，等待期间仍占用执行名额。
- 附件支持文本、PDF、DOCX。图片只保存原件，不做识别。Web 单文件 4 MiB，单次最多 10 个，每条消息合计 8 MiB。
- 桌面安装包未签名、未公证，目前只有 macOS。执行固定走 Pig 的沙箱和审批，不能改成直接在主机上跑命令。
- 本机开发服务的设置没有用系统密钥加密，不要暴露到公网。当前是内测：云账号按 token 用量扣减平台模型预算，但没有充值或支付；公网内测可参考 [腾讯云单机部署](docs/tencent-deployment.md)，不代表高可用生产方案。

架构、桌面打包和云平台细节见 [架构说明](docs/architecture.md)、[桌面客户端](docs/desktop.md)、[本地云平台](docs/local-cloud.md)。运行时选型见 [运行时选型](docs/runtime-selection.md)。改代码的顺序和测试要求见 [AGENTS.md](AGENTS.md)。

## 专家、技能与 MCP

Web 打开「设置 → 扩展与 MCP」，桌面打开「设置 → 插件」。先查看内置包内容，安装后启用，再在任务配置里选择专家或技能。包提供工作方法，不执行安装脚本、不扩大工具权限；桌面仍支持导入 `pig-plugin-v1` JSON 包。云账号之间的安装内容相互隔离。

技能支持 `SKILL.md` + `scripts/*.py` + `references/*` + `assets/*` 的目录包，可在技能页导入文件夹、查看脚本和参考资料，并点击「开始对话」。内置技能使用中文名称和说明，规范标识仍为英文短名。输入框键入 `/` 可以搜索和加载技能；专家可绑定多个技能，自动化也可选择技能。

任务保存技能快照，运行时将资源放入版本隔离的工作区目录，按需读取，不把脚本全文塞进系统提示词。脚本仍受沙箱、工具权限与审批约束，导入不会运行代码。本轮支持 UTF-8 文本资源、单层资源目录与 Python 脚本；大小限制及使用示例见 [技能包说明与验收记录](docs/skill-pack-upgrade-2026-09-24.md)。

「MCP 连接」里填写服务名称、HTTP 地址、可选 Bearer 凭据和超时，保存、测试后启用。使用官方 TypeScript SDK 1.30.0，当前支持 Streamable HTTP 的工具发现与调用，凭据可以是静态 Bearer 或 OAuth 2.1 client_credentials（见上文「远端 MCP 凭据」）；不支持 stdio、交互式 OAuth 授权码流程、资源或提示词接口。工具较多时只暴露 `search_tools`，按需检索激活（`PIG_TOOL_SEARCH`）。桌面凭据进系统保险箱；云凭据由控制面加密保存，不下发 Runner。普通云账号只能连接公网地址，项目协同不会隐式使用个人 MCP 连接。

完整的边界、排障与模拟服务复验命令见 [扩展与 MCP 使用说明](docs/ecosystem-mcp.md)。
