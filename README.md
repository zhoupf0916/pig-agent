# Pig Agent

交代一个任务，它在云端沙箱或这台电脑上做完。你批准写入、核对成果，然后继续。

浏览器打开即可使用，不必安装本机服务。桌面版可以在本机执行，也可以加入同一个云端项目。

## 亮点

- **对话即任务**：从一句话开始。项目收纳对话和文件，技能、专家和权限在输入栏里选择。
- **先看再写**：写入和命令可以在执行前审批。拒绝或取消后，后续操作不会继续。
- **沙箱执行**：云端任务跑在 Runner 的原生进程里，不为每个任务另起 Docker 容器。本机任务默认使用操作系统沙箱。
- **协作**：申请账号后由管理员批准。项目可以仅自己可见，或与组织成员共享。私人记忆不会带进共享任务。
- **账号预算**：新账号默认一次性 2 元平台模型预算，按 token 用量结算，调用前预留并拦截超额；管理员可修改总预算与每日调用上限。
- **离开也能跑**：定时任务由控制面调度。关闭网页后，云端任务仍会继续，回来可以接着看。
- **扩展与 MCP**：内置编码质量、文档写作、数据分析、资料研究、故障排查五个基础包，以及创意构思、排期、体验研究、趣味交互、分镜和小游戏六个[社区精选包](docs/curated-skills.md)；可连接 Streamable HTTP MCP 工具，每次外部调用单独审批。

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

这会在本地启动 PostgreSQL、控制面、模型网关和 Runner。浏览器本身不执行主机命令。首次使用在工作台申请账号，由管理员批准后登录。默认使用模拟模型；管理员配置并启用真实模型渠道后，任务才会调用真实模型。

```bash
pnpm cloud:status    # 查看服务状态
pnpm cloud:logs      # 查看服务日志
pnpm cloud:down      # 停止服务，保留数据库

# 开发 Web 界面：保持上述平台运行，再在另一个终端启动
pnpm dev             # http://127.0.0.1:5173/，云接口代理到 8890
```

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
  cloud/        本地 Docker 平台配置
  tencent/      腾讯云单机部署、HTTPS、限流与备份配置
scripts/        构建、启动、冒烟验证与运维脚本
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
```

多控制面、多 Runner 的本地验证使用 `pnpm cluster:up` 和 `pnpm cluster:smoke`；详细环境与限制见 [本地云平台](docs/local-cloud.md)。

## 上下文工程与评测

长对话使用有来源的目标、纠正、计划与证据摘录；完整转录保持不变。Pig 运行时可通过 `recall_context` 按消息 ID 分页查阅原文，避免因输出截断重复执行工具。历史证据不替代审批或当前文件状态核验。

```bash
pnpm eval:context                 # 离线新旧策略对照，不调用模型
pnpm eval:context --trials 10     # 重复组装测量，报告写入 data/evals/
```

[设计、权威参考、验收结果与面试讲述](docs/context-engineering-v2.md)。字符预算不等于模型 token 窗口；离线证据保留率不等于模型任务成功率，真实模型评测需显式配置独立环境变量。

## 注意事项

- Web 任务固定在云端沙箱。桌面任务可以选择这台电脑，或加入云端项目。
- 新建项目时导入的文件夹是一份初始副本，不会持续同步本机目录。共享项目里，每个会话保留自己的文件版本。
- 网络默认逐次审批；HTTPS 读取或 MCP 调用只批准当前请求，不会放开沙箱任意联网。MCP 在外部服务执行，不属于本机或 Runner 的沙箱。
- 审批最多等待 30 分钟，等待期间仍占用执行名额。
- 附件支持文本、PDF、DOCX。图片只保存原件，不做识别。Web 单文件 4 MiB，单次最多 10 个，每条消息合计 8 MiB。
- 桌面安装包未签名、未公证，目前只有 macOS。执行固定走 Pig 的沙箱和审批，不能改成直接在主机上跑命令。
- 本机开发服务的设置没有用系统密钥加密，不要暴露到公网。当前是内测，没有账号计费；公网内测可参考 [腾讯云单机部署](docs/tencent-deployment.md)，不代表高可用生产方案。

架构、桌面打包和云平台细节见 [架构说明](docs/architecture.md)、[桌面客户端](docs/desktop.md)、[本地云平台](docs/local-cloud.md)。运行时选型见 [运行时选型](docs/runtime-selection.md)。改代码的顺序和测试要求见 [AGENTS.md](AGENTS.md)。

## 专家、技能与 MCP

Web 打开「设置 → 扩展与 MCP」，桌面打开「设置 → 插件」。先查看内置包内容，安装后启用，再在任务配置里选择专家或技能。包提供工作方法，不执行安装脚本、不扩大工具权限；桌面仍支持导入 `pig-plugin-v1` JSON 包。云账号之间的安装内容相互隔离。

技能支持 `SKILL.md` + `scripts/*.py` + `references/*` + `assets/*` 的目录包，可在技能页导入文件夹、查看脚本和参考资料，并点击「开始对话」。内置技能使用中文名称和说明，规范标识仍为英文短名。输入框键入 `/` 可以搜索和加载技能；专家可绑定多个技能，自动化也可选择技能。

任务保存技能快照，运行时将资源放入版本隔离的工作区目录，按需读取，不把脚本全文塞进系统提示词。脚本仍受沙箱、工具权限与审批约束，导入不会运行代码。本轮支持 UTF-8 文本资源、单层资源目录与 Python 脚本；大小限制及使用示例见 [技能包说明与验收记录](docs/skill-pack-upgrade-2026-09-24.md)。

「MCP 连接」里填写服务名称、HTTP 地址、可选 Bearer 凭据和超时，保存、测试后启用。使用官方 TypeScript SDK 1.30.0，当前支持 Streamable HTTP 的工具发现与调用；不支持 stdio、OAuth、资源或提示词接口。桌面凭据进系统保险箱；云凭据由控制面加密保存，不下发 Runner。普通云账号只能连接公网地址，项目协同不会隐式使用个人 MCP 连接。

完整的边界、排障与模拟服务复验命令见 [扩展与 MCP 使用说明](docs/ecosystem-mcp.md)。
