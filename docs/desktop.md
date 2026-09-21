# Electron 桌面客户端

## 当前交付范围

macOS 内测客户端，复用 Web 工作台与本地服务。安装后不需要 Node.js / pnpm。首次选择工作目录并填写模型参数，可测试模型连接；Docker 和 Codex CLI 仍需用户自行安装。

关闭最后一个窗口或退出应用会停止本地服务，自动化仅在应用运行时调度；当前不支持退出后后台常驻任务。

## 开发与打包

从仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm desktop:dev
pnpm desktop:pack  # 生成 .app，便于本机调试
pnpm desktop:dist  # 生成 DMG 与 ZIP
```

产物位于 `release/`，默认打包当前 macOS 主机的架构。GitHub Actions 的 Desktop workflow 可手动运行，也在涉及应用、构建或依赖的 PR 中运行，附件供内部测试下载。未签名版本可能被 macOS Gatekeeper 拦截；不要关闭系统整体安全检查。公开发布需要维护者配置 Developer ID、Hardened Runtime、公证与分发流程，不能把内部测试包当作已公证版本。

目前没有自动更新、Windows 或 Linux 发行版。帮助菜单提供仓库说明与版本入口。

## 运行与安全边界

- Electron utility process 使用随应用附带的 Node 启动服务，监听 `127.0.0.1` 的随机端口。
- 每次启动生成随机认证令牌，静态资源与 API 都受鉴权保护。令牌不进入 renderer、URL 或 localStorage，后端启动后从环境移除，避免命令子进程继承。
- renderer 使用固定的 `pig://app` 地址，主进程代理到当前后端；草稿、主题与首次配置状态不随端口变化丢失。
- 关闭 Node integration，启用 context isolation、renderer sandbox、CSP，拒绝网页权限申请、外部页面导航和 webview。
- preload 只暴露目录选择与应用信息；文件与命令仍通过服务端任务的审阅流程执行。
- 使用 Electron safeStorage 加密模型密钥与 Cloud token，保存在 `credentials.bin`；普通 `settings.json` 不包含这两个密钥的明文。读取设置时只向 UI 返回「已配置」标志；输入框留空保留原值，填写新值可替换。
- 系统加密不可用时不降级成明文。备份凭据后换机器可能无法解密，需重新配置自己的密钥。

Electron renderer 沙箱保护的是界面，不代表 Agent 命令自动运行在 Docker 中。Agent 仍可按任务设置使用本机或 Docker；应用和同用户进程不是彼此隔离的安全租户。

## 数据与诊断

macOS 默认应用数据位于 `~/Library/Application Support/Pig Agent/`（以「帮助 → 打开应用数据目录」实际显示为准）：

```text
data/             设置、会话、项目、记忆与交付记录
workspace/        首次启动的默认工作目录
credentials.bin   系统加密后的凭据
其他 Electron 数据  草稿、主题与浏览器存储
```

应用不读取仓库 `.env` / `.env.local`，不继承开发者模型凭据。安装包只包含运行必需的编译产物与内置 skills，不包含开发数据。

「帮助 → 导出诊断信息」仅导出版本、平台、架构、后端状态和时间，不导出对话、路径或密钥。后端异常退出会提示重新打开应用。开发验证可用 `PIG_DESKTOP_USER_DATA` 指定隔离数据目录。

## 验收

```bash
pnpm desktop:build
pnpm desktop:smoke
# 已打包的 .app
node scripts/smoke-desktop.mjs --packaged
```

测试使用临时数据与本机假模型，校验无令牌请求被拒绝、renderer 无 Node 权限、受限桥可用、模型请求成功、密钥加密且 API 不回传密钥。测试退出后删除临时数据。

人工验收：首次启动 → 选择目录 → 输入自己的模型配置 → 测试连接 → 发起任务 → 审阅并批准写入 → 查看实际文件 → 退出重开检查会话和草稿 → 导出诊断。不要在连接测试中使用他人的密钥。
