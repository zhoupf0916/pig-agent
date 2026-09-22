# Pig Agent

一个支持云端协作与本机执行的 AI 工作台。**Web 直接连接控制面，所有任务由云端 Runner 执行**；**Electron 客户端保留本机能力，并可在项目协同中加入同一云端项目**。用户访问 Web 前端即可使用 Agent，不需要安装本机服务。

本地执行时，会话和工作文件保存在本机；选择远端执行时，控制面保存远端会话、事件和工作区快照，Agent 在 Runner 的原生进程沙箱中运行。选择 DeepSeek 等远程模型时，请求会发送到所配置的模型服务。Pig 使用 OpenAI 兼容 Chat Completions 接口；可选的本机 Codex CLI 引擎使用独立的 Responses 接口。

Web 保留完整工作台导航：工作台、项目、专家与技能、自动化、记忆、搜索、远端记录和设置。项目协同只作为「项目」下的分支，不再单独替代工作台。专家与技能可保存至当前云端账号，并用于新任务；个人记忆不会注入项目协同会话。详见[恢复完整工作台验收](docs/workbench-restoration-2026-09-22.md)。

项目入口包含普通项目与项目协同。Web 新建普通项目可选择本地文件夹，将代码/文档复制到云端初始工作区（不持续同步本机目录）；支持子目录，续聊恢复各自任务快照。详见[文件夹导入边界](docs/project-folder-import-2026-09-22.md)。多工作区与审批档位的操作、边界及真实验证见 [本轮修复记录](docs/workspaces-approval-layout-2026-09-22.md)。本机项目可绑定多个本地目录、设置默认工作区，新建任务时选择一个并固定执行目录；云端项目汇总每个会话保存的文件版本，续聊恢复该会话工作区。成员不会共用一个可同时覆盖的文件目录。

首次访问选择「申请账号」，管理员在 `/admin/` 的「账号与配额」批准后即可使用账号密码登录。本地首次初始化管理员运行 `node scripts/setup-admin-password.mjs`，随机初始密码仅保存在 `data/cloud-local/accounts.txt`（0600），已有账号不会被重置。详见 [账号访问说明](docs/password-account-access.md)。

本机 Pig 任务默认使用原生操作系统沙箱（macOS Seatbelt / Linux Bubblewrap + seccomp），关闭沙箱时 shell 使用本机进程权限。云端任务使用 Runner 内的原生进程沙箱，不再创建任务 Docker 容器；网络可选择禁止或逐次审批，授权只允许该次公网 HTTPS GET，不开放任意 shell 联网。详见 [项目工作区与验收记录](docs/project-workspaces-2026-09-22.md)。

## 能做什么

- **任务执行**：流式对话、工具执行、计划与产物预览，停止、重试和继续任务。
- **审阅与验收**：写入前查看差异、批准或拒绝操作、文件快照撤销、磁盘结果核验。
- **工作目录与环境**：指定真实目标目录；命令选择原生沙箱或本机执行，明确显示执行位置。
- **工作台管理**：项目、资料上传、专家与顺序小队、任务模板、本机搜索和记忆。
- **自动化与预算**：本机定时任务、控制面远端定时调度、用量记录、本机预算和平台每日调用限额。
- **执行位置**：Web 固定使用云端 Runner；Electron 可使用本机 Pig / Codex，也可在项目分支中使用云端项目协同。
- **远端会话**：跨设备恢复、跨轮工作区快照、日志与成果下载，以及成果审阅后导入本机。
- **团队协作**：账号密码登录、首次申请与后台审批、组织与项目协同、管理员/编辑/只读成员权限、跨成员跟进同一会话、显示消息作者、通过 SSE 实时查看执行与回复。
- **云端审批**：可选的写入和命令审批，由控制面保存决定；批准前不执行，取消后旧审批失效。

具体范围与限制见 [交付链路](docs/delivery-loop.md)、[功能参考](docs/workbench-reference.md) 和 [控制面验收](docs/control-plane-acceptance.md)。当前为申请审批制内测，尚未提供账号计费、完整本地目录云同步或公网生产部署方案。

## 本机 Docker 云平台（开发预览）

执行 `pnpm cloud:up` 会构建并启动 PostgreSQL、云端 API、模型网关和 Worker，真实任务在 Runner 的原生进程沙箱执行。Web 用户访问 [云端工作台](http://127.0.0.1:8890/)，使用账号密码登录，首次使用先申请账号，由管理员审批；桌面用户在设置中配置远端连接，再打开「项目 → 项目协同」。管理员入口为 [管理后台](http://127.0.0.1:8890/admin/)。首次设置管理员密码运行 `node scripts/setup-admin-password.mjs`，生成的本机凭据文件请妥善保存。

桌面任务可选择本地/远端执行，Web 任务固定由云端执行；自动化可选择由控制面调度的远端计划，关闭客户端后仍执行。工作台可跨设备恢复远端会话、延续工作区、下载版本，并将文本成果转为本地待批准变更单。后台支持邀请账号、登录撤销、每日调用预算、加密模型渠道、节点排空、并发和 Runner 资源规格。默认仍是模拟模型；管理员可添加并启用真实渠道。详见 [本地云平台运行与验收](docs/local-cloud.md) 和 [分阶段扩展计划](docs/platform-expansion-plan.md)。个人模型密钥不会自动配置到平台。

```bash
# 需要先启动 Docker Desktop；从仓库根目录执行
pnpm cloud:up       # 构建镜像并启动本地控制面与执行服务
pnpm cloud:status   # 查看常驻容器
pnpm cloud:logs     # 查看服务日志
pnpm cloud:down     # 停止平台并清理执行资源，保留数据库卷
```

Docker Desktop 的 **Containers → pig-agent-cloud** 下有四个常驻服务：

| 服务 | 职责 |
| --- | --- |
| `cloud` | 控制面 API、调度、审批与管理后台，监听本机 `8890` |
| `worker` | 按控制面租约启动可信 Agent 进程，工具使用原生沙箱，取消后回收进程和工作区 |
| `gateway` | 模型请求代理与调用限额检查 |
| `postgres` | 账号、任务、会话、快照、审批与审计数据 |

每个任务是 Runner 内的原生进程，不会出现 `pig-run_…` 临时 Docker 容器；启动时另有短命的 `worker-storage-init` 服务迁移 outbox 卷权限。当前这套“云端执行”部署在本机 Docker 中；部署到远程主机后才使用那台主机的资源。Web 前端直接由控制面提供。原本机 Web 地址默认跳转到控制面，本机执行 API 已关闭；开发回归可显式设置 `PIG_LOCAL_WORKBENCH=1`。

在云端工作台「组织与成员」管理共享项目；新任务默认写入前审批。共享会话在 Web 与桌面使用同一控制面上下文，同一会话并发提交冲突会保留输入供重试。审批等待仍占用 Runner 槽位，但暂停执行计时，最多等待 30 分钟；取消和租约失效仍会停止执行。共享项目自动化与文件库、节点故障后的任务自动恢复、远端 Codex、对象存储和自动保留期尚未实现。

详细边界、登录方式与多人验证见 [Web 云端协作](docs/cloud-web-collaboration-2026-09-22.md)。HTTPS 反向代理需配置 `WEB_PUBLIC_ORIGIN` 为公开站点源；Web 登录 cookie 为 HttpOnly，12 小时有效。

## 工作台与交互

本轮从上一版未通过的[独立验收](docs/acceptance-review-2026-09-22.md)出发，重新组织工作台，而不只调整配色：

- **一个导航入口**：全局页面与最近任务集中在左栏；任务标题、状态与少量操作保留在主区单行标题栏。手机使用抽屉导航。
- **输入先于面板**：新任务以工作区、任务描述和执行配置为中心；没有成果时不常驻空文件栏。
- **在当前任务处理审批**：执行摘要、文件差异、命令及批准/拒绝按钮出现在会话内；原始参数放在可展开详情中。支持停止、失败后重试和继续对话。
- **按来源核验成果**：检查器按需展开，桌面宽度可调，手机使用抽屉。远端文件使用所属运行和成果 ID 获取授权内容，支持历史版本、对比、日志和下载，不读取本机同名文件。选择「审阅并导入到本机」会创建独立变更单，批准后才写入目标工作区。
- **分组设置**：模型连接、执行默认值、工作区、远端连接、外观和高级选项分别呈现；提供保存反馈、校验与未保存草稿保护。默认值、当前任务配置与平台调度设置有各自作用范围。
- **一致的管理端**：与工作台共用浅色/深色视觉 token，保留独立管理员鉴权。Runner 采用可搜索的紧凑列表，默认展示在线节点，历史离线记录单独筛选；概览明确区分当前资源与累计结果。任务详情直接查看日志及授权成果。

本版同时修复三项正确性问题：完成提交暂时失败不再把成功执行改写成失败；远端成果不再映射为本机路径；已被替代的 Runner 代次不能通过迟到注册重新取得所有权。

项目与专家采用概览卡片和独立详情，输入附件与执行成果分开展示。审批一次只处理一项：等待期间阻塞执行，批准后继续原工具批次，拒绝或取消后停止后续操作。详见[阻塞审批与恢复](docs/blocking-approval-2026-09-22.md)。

Web 消息支持多文件选择、拖拽、粘贴截图、上传失败重试和授权下载；文本、PDF、DOCX 可提取内容，图片目前仅保存原件，**不提供视觉理解或 OCR**。Web 限制为单文件 4 MiB、每会话累计 8 MiB、每次提交最多 10 个附件；桌面上传使用所选本地工作区。详细格式、配额与权限见[附件说明](docs/attachments-2026-09-22.md)。

[最新实施与验收记录](docs/native-productization-worklog.md) · [同尺寸前后截图](docs/evidence/joydesk-workbench-2026-09-22/comparison/index.html) · [UI 操作与验收](docs/joydesk-workbench-2026-09-22.md)

对照页包含 54 张截图，覆盖 9 个状态的改版前后效果及 1440×900、1280×800、390×844 三种尺寸；另有深色、长内容与 Electron 实机检查。下载仓库后可用浏览器打开 HTML 对照页。视觉检查与功能测试分别记录，测试通过不代替界面验收。

### 原生任务沙箱

基础服务继续用 Docker Compose 部署，任务沙箱使用操作系统隔离。Runner 不挂 Docker socket；Linux 部署需允许 Bubblewrap 创建子命名空间，缺失能力时启动自检拒绝注册。具体 seccomp、`systempaths` 配置及排障见 [原生 Runner 迁移与验证](docs/native-runner-2026-09-22.md)。

每个 Runner 有 4 GiB / 1024 PID 的整体硬限制；每任务内存、PID、CPU 是采样观察后的终止保护，**CPU 规格不是每任务硬 CPU 份额**，不提供严格租户资源配额。节点崩溃后失去租约的任务标记失败，不自动重放未知副作用；完成 outbox 重试的是结果交付，不是重新执行，也不代表 exactly-once。

### 控制面与 Runner 集群

PostgreSQL 协调并发领取、公平调度、队列背压和运行租约。Runner 支持注册、心跳、容量与资源规格、排空和代次隔离。双控制面、双 Runner 环境使用独立数据库和默认 mock 模型，不需要另设用户端「云工作台」。

```bash
# 先启动 Docker Desktop，从仓库根目录执行
pnpm cluster:up       # 构建并启动双控制面、双 Runner；管理入口 8892
pnpm cluster:status
pnpm cluster:smoke    # 并发竞争、Runner 节点故障与资源回收
pnpm product:smoke    # 自动启动隔离 8798，运行真实浏览器流程并保存截图
pnpm cluster:logs
pnpm cluster:down    # 保留数据库和 Runner outbox 命名卷
```

`product:smoke` 需要空闲的 8798 端口，会自行关闭测试工作台；使用独立数据目录，不操作原 8797 工作台。默认使用已安装的 Google Chrome。也可先执行 `pnpm exec playwright install chromium`，然后运行 `PIG_BROWSER_CHANNEL=chromium pnpm product:smoke`。浏览器证据输出到 `data/product-evidence/`。

完成交付与旧代次的专项回归：

```bash
# 仅在没有活动用户任务的独立 mock 集群执行；部分脚本临时排空节点
node scripts/smoke-cluster-migration.mjs
node scripts/smoke-completion-fencing.mjs
node scripts/smoke-completion-delivery.mjs
```

Runner 在私有持久 outbox 中保存原始完成结果，再向控制面提交；同一提交重放只确认原结果，不重复插入成果。暂时不可达时重试交付，不重新执行任务。超过租约或已被隔离的结果会保留供核验，不绕过失效凭据恢复终态。持久卷包含执行凭据和任务内容，不能作为普通日志公开上传。详见[完成交付语义、排障与故障验证](docs/completion-delivery.md)。

[集群部署与排障](docs/cluster.md) · [上一轮产品化记录](docs/productization-worklog.md)

这仍是单 Docker 主机的多实例验证，不代表数据库、宿主机或磁盘高可用，也不宣称 exactly-once 执行。等待审批仍占用运行资源且受时限约束。跨主机复制、对象存储、自动数据保留、公网 TLS 与节点证书、远端 Codex、共享项目自动化和桌面签名更新尚未交付。

## 桌面版（macOS 内测）

Electron 打包了界面和本地 Node 服务，使用者无需安装 Node.js 或 pnpm。首次打开后：

1. 选择工作目录。
2. 填写模型接口地址、模型名和自己的 API Key。
3. 点击「保存并测试连接」，然后进入工作台。测试会产生一次简短的模型请求。
4. 输入目标创建任务，在会话内审阅待批准操作，再打开成果检查器核验文件。

开发者可执行 `pnpm desktop:dist` 生成 DMG / ZIP，输出在根目录 `release/`。GitHub 的 **Desktop / Package macOS** workflow 也会生成可下载的构建附件。当前属于**未签名、未公证的内部测试包**；正式公开分发前仍需配置 Apple Developer 签名、公证和更新发布流程。暂未提供 Windows / Linux 安装包。

0.1.1 已接入 Codex 独立密钥、同提供商显式复用与真实 CLI 连接检测。Codex 是执行引擎，模型仍由所配置的提供商决定；不复用当前 ChatGPT 应用账号。Codex 写入遵循自身沙箱，不经过 Pig 的逐项审阅。

密钥通过 Electron `safeStorage` 加密，普通设置和会话保存在应用数据目录。菜单「帮助」提供数据目录入口与不含密钥、会话内容的诊断导出。详见 [桌面运行、打包与分发](docs/desktop.md)。

> Docker、Git、Codex CLI 等属于可选工具，安装包不包含它们。原生沙箱不可用会拒绝执行，不自动降级；明确关闭沙箱后，本机命令拥有当前用户权限。

## 从源码运行

需要 Node.js **22.13+**（建议 24）与 pnpm **11.19.0**。构建原生文件助手需要 C 编译器：macOS 安装 Xcode Command Line Tools，Linux 安装对应发行版的编译工具；Linux 本机沙箱还需要 Bubblewrap。云端所需工具已包含在 Runner 镜像中。所有命令从仓库根目录运行。

```bash
pnpm install --frozen-lockfile

# 网页端及控制面（需要 Docker Desktop）
pnpm cloud:up

# 桌面客户端
pnpm desktop:dev
```

打开 [Web 工作台](http://127.0.0.1:8890/) 或[管理后台](http://127.0.0.1:8890/admin/)。网页模型由管理员在平台渠道中配置；桌面本机模型在客户端设置中配置，两者独立。首次安装默认使用模拟模型，启用真实渠道后才调用真实模型。

```bash
# Web 前端开发：先启动上述云平台，再启动 Vite（5173）
pnpm dev

# 构建共用界面；默认启动入口会跳转至控制面
pnpm build
pnpm start

# 仅用于本机执行界面开发与回归（5173 / 8787）
PIG_LOCAL_WORKBENCH=1 pnpm dev

# Electron 开发启动（会先构建界面和后端）
pnpm desktop:dev

# macOS 安装包，输出 release/
pnpm desktop:dist

# 仅生成未封装的桌面应用目录
pnpm desktop:pack
```

显式启用本机开发模式时默认使用 `data/` 和 `sample-workspace/`，支持 `DATA_DIR`、`WORKSPACE_ROOT`、`PORT` 覆盖。桌面模式使用独立的应用数据目录，不读取仓库的 `.env`，也不携带开发者的密钥或会话。本机开发模式的设置文件未做系统密钥加密，不要把开发服务器开放到公网。

## 仓库结构

```text
apps/
  web/             React 工作台；浏览器与桌面共用
  server/          Hono API、Agent 执行、本机存储与运行时适配器
  desktop/         Electron 主进程、预加载桥、本地服务生命周期
  cloud/           控制面、定时调度、组织权限、审批和模型网关
  worker/          原生任务进程的租约、执行和回收
  admin/           控制面管理后台
packages/
  contracts/       共享类型、事件与 Cloud 协议；不依赖 Node / React / Electron
  design/          工作台与管理端共用的视觉 token
scripts/           构建、架构边界检查和桌面冒烟测试
infra/cloud/       单控制面 Docker Compose 与 Runner 服务镜像
infra/cluster/     双控制面、双 Runner 与入口代理
skills/            内置 Agent 技能
examples/          示例与可选集成
sample-workspace/  开发演示工作区
tests/            测试环境隔离配置
docs/             架构、使用、验收和运行时文档
```

应用通过 workspace 包使用契约，禁止相互导入源码。`apps/cloud` 是远端执行控制面，`apps/worker` 管理原生沙箱任务进程，`apps/admin` 提供管理后台；用户端继续复用同一工作台。控制面已提供定时调度、远端会话恢复和工作区快照版本。组织共享项目与三档成员权限、可选的云端工具审批已接入同一工作台。审批等待独立限时 30 分钟，执行计时暂停；远端 Codex、对象存储与自动保留期尚未实现。设计边界与演进规则见 [架构说明](docs/architecture.md)。

## 验证与贡献

```bash
pnpm check:architecture  # 应用与共享包的依赖边界
pnpm typecheck          # 契约、服务端和 Web
pnpm test               # 隔离数据与模型环境的回归测试
pnpm desktop:build      # Web 构建 + 可随应用分发的后端 bundle
pnpm desktop:smoke      # 真 Electron + 本机假模型，验证鉴权与密钥隔离

# 以下需要已启动本地 Docker 平台，默认使用 mock 模型
pnpm cloud:smoke
pnpm cloud:smoke:conversations
pnpm cloud:smoke:collaboration
pnpm cloud:smoke:approvals
```

桌面冒烟需要图形环境和可用的系统密钥存储，不消耗真实模型额度。macOS 打包 CI 还会对打包后的 `.app` 运行同样的测试。

2026-09-22 的最终回归共 **119 个测试文件、732 项测试通过**，架构和各应用类型检查通过，Web、云端与 macOS arm64 桌面包已构建。双控制面、双 Runner 验证了并发、租约失效、取消、排空、完成交付重试和旧代次隔离；另用已配置的 DeepSeek 渠道验证了真实审批与文件产出。测试环境为本机 Docker Desktop 与 macOS，不能据此推断生产容量。具体证据、截图与已知限制见[最新验收记录](docs/native-productization-worklog.md)。Web 构建仍有较大 bundle 提示，桌面包尚未签名或公证。源码中的 `scripts/redesign/` 保留视觉验收脚本，其中前后对照脚本依赖本轮基线清单和隔离夹具，并非空仓库的一键初始化；日常可复现回归优先使用上面的 `product:smoke`。mock 验收用于确认执行链路，不代表真实模型任务质量或生产容量。备份恢复命令见[本地云平台文档](docs/local-cloud.md)。

- [架构与依赖规则](docs/architecture.md)
- [桌面客户端](docs/desktop.md)
- [交付链路与验收](docs/delivery-loop.md)
- [2026-09-21 回归报告](docs/regression-2026-09-21.md)
- [人工验收清单](MANUAL_TEST.md)
- [Cloud 运行时](docs/cloud-runtime.md) / [Codex 运行时](docs/codex-runtime.md)
