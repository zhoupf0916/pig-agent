# Pig Agent

一个本地优先的 AI 工作台：描述任务、审阅改动、执行工具，再核验交付结果。提供 **Web 工作台**与 **Electron 桌面客户端**，共用本地服务和接口契约。

本地执行时，会话和工作文件保存在本机；选择远端执行时，控制面保存远端会话、事件和工作区快照，Agent 在独立容器中运行。选择 DeepSeek 等远程模型时，请求会发送到所配置的模型服务。Pig 使用 OpenAI 兼容 Chat Completions 接口；可选的本机 Codex CLI 引擎使用独立的 Responses 接口。

## 能做什么

- **任务执行**：流式对话、工具执行、计划与产物预览，停止、重试和继续任务。
- **审阅与验收**：写入前查看差异、批准或拒绝操作、文件快照撤销、磁盘结果核验。
- **工作目录与环境**：指定真实目标目录；命令选择本机或 Docker，明确显示执行位置。
- **工作台管理**：项目、资料上传、专家与顺序小队、任务模板、本机搜索和记忆。
- **自动化与预算**：本机定时任务、控制面远端定时调度、用量记录、本机预算和平台每日调用限额。
- **执行位置**：同一 Web / Electron 工作台选择本地或远端容器；本机支持 Pig 与 Codex CLI。
- **远端会话**：跨设备恢复、跨轮工作区快照、日志与成果下载，以及成果审阅后导入本机。
- **团队协作**：邀请制账号、组织与共享项目、管理员/编辑/只读成员权限、跨成员跟进任务。
- **云端审批**：可选的写入和命令审批，由控制面保存决定；批准前不执行，取消后旧审批失效。

具体范围与限制见 [交付链路](docs/delivery-loop.md)、[功能参考](docs/workbench-reference.md) 和 [控制面验收](docs/control-plane-acceptance.md)。当前为邀请制内测，尚未提供账号计费、完整本地目录云同步或公网生产部署方案。

## 本机 Docker 云平台（开发预览）

执行 `pnpm cloud:up` 会构建并启动 PostgreSQL、云端 API、模型网关和 Worker，真实任务在独立容器执行。用户继续使用现有 Web / Electron 工作台，并通过 Cloud / remote 适配器连接控制面；管理员入口为 [管理后台](http://127.0.0.1:8890/admin/)，访问令牌在本机 `data/cloud-local/access.txt`。

会话顶部选择本地/远端执行，自动化可选择由控制面调度的远端计划，关闭客户端后仍执行。工作台可跨设备恢复远端会话、延续工作区、下载版本，并将文本成果转为本地待批准变更单。后台支持邀请账号、登录撤销、每日调用预算、加密模型渠道、节点排空、并发和容器资源规格。默认仍是模拟模型；管理员可添加并启用真实渠道。详见 [本地云平台运行与验收](docs/local-cloud.md) 和 [分阶段扩展计划](docs/platform-expansion-plan.md)。个人模型密钥不会自动配置到平台。

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
| `worker` | 按控制面租约创建、停止和回收执行容器 |
| `gateway` | 模型请求代理与调用限额检查 |
| `postgres` | 账号、任务、会话、快照、审批与审计数据 |

`pig-run_…` 是按任务创建的临时 Agent 容器，任务结束后回收，空闲时不会出现在列表中。当前这套“云端执行”部署在本机 Docker 中；部署到远程主机后才使用那台主机的资源。Web / Electron 用户入口保持不变。

在「远端运行记录 → 组织与共享项目」管理组织和任务；新建远端会话时可勾选「写入前审批」。审批等待仍占用容器并计入运行时限。共享项目自动化与文件库、长期审批暂停/故障恢复、远端 Codex、对象存储和自动保留期尚未实现。

## 0.2.0 产品化内测：控制面与 Runner 集群

工作台补齐任务搜索筛选、远端日志与断线恢复、移动端设置、审批反馈与长会话阅读；管理后台提供运行概览、任务日志、Runner、执行模型、账号配额、计划审计六个页面。

控制面通过 PostgreSQL 协调并发领取、公平调度、队列背压和运行租约。Runner 支持注册与心跳、容量/资源规格能力、排空、启动代次隔离和退出清理；审批与事件传输具有幂等标识。已提供独立于原本地平台的双控制面、双 Runner 验证环境：

```bash
pnpm cluster:up       # 独立数据库与 mock 模型，入口 8892
pnpm cluster:smoke    # 协议竞争 + 真实容器故障验收
pnpm product:smoke    # 隔离 8798 工作台的真实浏览器操作与截图
pnpm cluster:down
```

浏览器验收默认使用已安装的 Google Chrome；也可运行 `pnpm exec playwright install chromium`，然后设置 `PIG_BROWSER_CHANNEL=chromium` 执行。`product:smoke` 自行启动和关闭隔离工作台，运行前需空出 8798 端口，不操作原 8797 的用户数据。

[集群部署与排障](docs/cluster.md) · [产品化目标、验收与已知限制](docs/productization-worklog.md)

这是本机 Docker 的多实例验证，不代表数据库或宿主机高可用。已启动任务失联后不会自动重放副作用，不宣称 exactly-once。对象存储、数据自动保留期、公网 TLS 与节点证书、远端 Codex、共享项目自动化和桌面签名更新仍不在本版本已交付范围。

## 桌面版（macOS 内测）

Electron 打包了界面和本地 Node 服务，使用者无需安装 Node.js 或 pnpm。首次打开后：

1. 选择工作目录。
2. 填写模型接口地址、模型名和自己的 API Key。
3. 点击「保存并测试连接」，然后进入工作台。测试会产生一次简短的模型请求。
4. 直接输入即可自动创建任务，在「执行与验收」里审阅改动并核验产物。

开发者可执行 `pnpm desktop:dist` 生成 DMG / ZIP，输出在根目录 `release/`。GitHub 的 **Desktop / Package macOS** workflow 也会生成可下载的构建附件。当前属于**未签名、未公证的内部测试包**；正式公开分发前仍需配置 Apple Developer 签名、公证和更新发布流程。暂未提供 Windows / Linux 安装包。

0.1.1 已接入 Codex 独立密钥、同提供商显式复用与真实 CLI 连接检测。Codex 是执行引擎，模型仍由所配置的提供商决定；不复用当前 ChatGPT 应用账号。Codex 写入遵循自身沙箱，不经过 Pig 的逐项审阅。

密钥通过 Electron `safeStorage` 加密，普通设置和会话保存在应用数据目录。菜单「帮助」提供数据目录入口与不含密钥、会话内容的诊断导出。详见 [桌面运行、打包与分发](docs/desktop.md)。

> Docker、Git、Codex CLI 等属于可选工具，安装包不包含它们。默认本机命令拥有当前用户的权限；文件访问范围不等于操作系统沙箱。

## 从源码运行

需要 Node.js **22.13+**（建议 24）与 pnpm **11.19.0**。所有命令从仓库根目录运行。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 [Web 工作台](http://127.0.0.1:5173)，后端监听 `127.0.0.1:8787`。在设置中填写模型与工作目录。也可以复制 `.env.example` 为 `.env.local` 配置模型，真实密钥不要提交到仓库。

```bash
# Web 生产构建与本地启动
pnpm build
pnpm start

# Electron 开发启动（会先构建界面和后端）
pnpm desktop:dev

# macOS 安装包，输出 release/
pnpm desktop:dist

# 仅生成未封装的桌面应用目录
pnpm desktop:pack
```

源码 Web 模式默认使用 `data/` 和 `sample-workspace/`，支持 `DATA_DIR`、`WORKSPACE_ROOT`、`PORT` 覆盖。桌面模式使用独立的应用数据目录，不读取仓库的 `.env`，也不携带开发者的密钥或会话。Web 模式的设置文件未做系统密钥加密，不要把开发服务器开放到公网。

## 仓库结构

```text
apps/
  web/             React 工作台；浏览器与桌面共用
  server/          Hono API、Agent 执行、本机存储与运行时适配器
  desktop/         Electron 主进程、预加载桥、本地服务生命周期
  cloud/           控制面、定时调度、组织权限、审批和模型网关
  worker/          执行容器的租约、创建和回收
  admin/           控制面管理后台
packages/
  contracts/       共享类型、事件与 Cloud 协议；不依赖 Node / React / Electron
scripts/           构建、架构边界检查和桌面冒烟测试
infra/cloud/       Docker Compose 与执行镜像
skills/            内置 Agent 技能
examples/          示例与可选集成
sample-workspace/  开发演示工作区
tests/            测试环境隔离配置
docs/             架构、使用、验收和运行时文档
```

应用通过 workspace 包使用契约，禁止相互导入源码。`apps/cloud` 是远端执行控制面，`apps/worker` 调度执行容器，`apps/admin` 提供管理后台；用户端继续复用同一工作台。控制面已提供定时调度、远端会话恢复和工作区快照版本。组织共享项目与三档成员权限、可选的云端工具审批已接入同一工作台。审批等待受容器时限约束；远端 Codex、对象存储与自动保留期尚未实现。设计边界与演进规则见 [架构说明](docs/architecture.md)。

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

0.2.0 的构建、测试、浏览器截图和集群故障验证证据见 [产品化工作记录](docs/productization-worklog.md)。mock 验收用于确认执行链路，不代表真实模型任务质量。完整验收、调度故障测试及备份恢复命令见 [本地云平台文档](docs/local-cloud.md)。

- [架构与依赖规则](docs/architecture.md)
- [桌面客户端](docs/desktop.md)
- [交付链路与验收](docs/delivery-loop.md)
- [2026-09-21 回归报告](docs/regression-2026-09-21.md)
- [人工验收清单](MANUAL_TEST.md)
- [Cloud 运行时](docs/cloud-runtime.md) / [Codex 运行时](docs/codex-runtime.md)
