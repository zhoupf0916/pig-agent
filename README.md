# Pig Agent

一个本地优先的 AI 工作台：描述任务、审阅改动、执行工具，再核验交付结果。提供 **Web 工作台**与 **Electron 桌面客户端**，共用本地服务和接口契约。

会话和工作文件保存在本机；选择 DeepSeek 等远程模型时，请求仍会发送到你配置的模型服务。支持 OpenAI 兼容 Chat Completions 接口。

## 能做什么

- **任务执行**：流式对话、工具执行、计划与产物预览，停止、重试和继续任务。
- **审阅与验收**：写入前查看差异、批准或拒绝操作、文件快照撤销、磁盘结果核验。
- **工作目录与环境**：指定真实目标目录；命令选择本机或 Docker，明确显示执行位置。
- **工作台管理**：项目、资料上传、专家与顺序小队、任务模板、本机搜索和记忆。
- **自动化与预算**：本机定时任务、用量记录、模型调用与费用预算。
- **可选运行时**：本机 Pig、外部 Codex CLI、Cloud local-stub / remote 适配器。

具体范围与限制见 [交付链路](docs/delivery-loop.md)、[功能参考](docs/workbench-reference.md)。当前没有多租户云端、账号计费或跨设备云同步。

## 桌面版（macOS 内测）

Electron 打包了界面和本地 Node 服务，使用者无需安装 Node.js 或 pnpm。首次打开后：

1. 选择工作目录。
2. 填写模型接口地址、模型名和自己的 API Key。
3. 点击「保存并测试连接」，然后进入工作台。测试会产生一次简短的模型请求。
4. 创建任务，在「执行与验收」里审阅改动并核验产物。

开发者可执行 `pnpm desktop:dist` 生成 DMG / ZIP，输出在根目录 `release/`。GitHub 的 **Desktop / Package macOS** workflow 也会生成可下载的构建附件。当前属于**未签名、未公证的内部测试包**；正式公开分发前仍需配置 Apple Developer 签名、公证和更新发布流程。暂未提供 Windows / Linux 安装包。

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
```

源码 Web 模式默认使用 `data/` 和 `sample-workspace/`，支持 `DATA_DIR`、`WORKSPACE_ROOT`、`PORT` 覆盖。桌面模式使用独立的应用数据目录，不读取仓库的 `.env`，也不携带开发者的密钥或会话。Web 模式的设置文件未做系统密钥加密，不要把开发服务器开放到公网。

## 仓库结构

```text
apps/
  web/             React 工作台；浏览器与桌面共用
  server/          Hono API、Agent 执行、本机存储与运行时适配器
  desktop/         Electron 主进程、预加载桥、本地服务生命周期
packages/
  contracts/       共享类型、事件与 Cloud 协议；不依赖 Node / React / Electron
scripts/           构建、架构边界检查和桌面冒烟测试
skills/            内置 Agent 技能
examples/          示例与可选集成
sample-workspace/  开发演示工作区
tests/            测试环境隔离配置
docs/             架构、使用、验收和运行时文档
```

应用通过 workspace 包使用契约，禁止相互导入源码。未来云端作为独立 `apps/cloud` 应用接入；当前 Cloud 目录是服务端的客户端适配器，不代表已实现云平台。设计边界与演进规则见 [架构说明](docs/architecture.md)。

## 验证与贡献

```bash
pnpm check:architecture  # 应用与共享包的依赖边界
pnpm typecheck          # 契约、服务端和 Web
pnpm test               # 隔离数据与模型环境的回归测试
pnpm desktop:build      # Web 构建 + 可随应用分发的后端 bundle
pnpm desktop:smoke      # 真 Electron + 本机假模型，验证鉴权与密钥隔离
```

桌面冒烟需要图形环境和可用的系统密钥存储，不消耗真实模型额度。macOS 打包 CI 还会对打包后的 `.app` 运行同样的测试。

- [架构与依赖规则](docs/architecture.md)
- [桌面客户端](docs/desktop.md)
- [交付链路与验收](docs/delivery-loop.md)
- [人工验收清单](MANUAL_TEST.md)
- [Cloud 运行时](docs/cloud-runtime.md) / [Codex 运行时](docs/codex-runtime.md)
