# Codex 运行时

产品已不再提供 Codex 执行选项，任务固定走 Pig。下文保留作历史说明。选型见 [运行时选型](runtime-selection.md)。

这里的 Codex 是**本机 Codex CLI 执行引擎**，负责工具调用、命令与文件操作。模型由独立的 Responses 服务提供；默认模型是 DeepSeek `deepseek-flash`。选择 Codex 不代表使用 OpenAI 模型，也不会使用当前 ChatGPT / Codex 应用的账号或额度。

## 配置

1. 安装 Codex CLI。当前自动回归固定验证 `@openai/codex@0.153.4`；桌面安装包不包含该 CLI。
2. 设置 → 运行时选择 Codex，填写 CLI 路径（默认从 PATH 查找；macOS 也检查 Codex / ChatGPT 应用内的可执行文件）。
3. 填写独立 Responses 地址、模型与 API Key。DeepSeek 已实测地址为 `https://api.deepseek.com/`、模型 `deepseek-flash`。
4. 若 Pig 已配置同一提供商，可点击「同一提供商：使用已保存的 Pig 密钥」。仅同源地址允许复用，必须显式操作。
5. 点击「保存并测试当前运行时」。测试在临时工作目录及独立 Codex home 中启动真实 CLI，会产生简短模型请求。

Codex 使用 `wire_api="responses"`，不会自动把 Pig 的 Chat Completions 地址或密钥带入。自定义提供商的接口要求见 [官方配置文档](https://learn.chatgpt.com/docs/config-file/config-advanced?translationFallback=zh-Hans)。

桌面版将 Codex、Pig 密钥及 Cloud token 分别交给系统加密存储。设置 API 不返回 Codex 密钥；输入框留空保留原值。Web 源码模式也可以使用环境变量：

```bash
CODEX_API_KEY=your-own-key
CODEX_BASE_URL=https://api.deepseek.com/
CODEX_MODEL=deepseek-flash
# 可选
CODEX_BIN=codex
PIG_CODEX_HOME=./data/codex-home
```

保存的专用 Codex 密钥优先于环境变量。未配置专用密钥时兼容 `DEEPSEEK_API_KEY` / `CODEX_API_KEY`；桌面版不继承终端的模型密钥。Web 设置文件没有系统加密，按当前用户权限保存，请勿公开开发服务。

## 执行与边界

实际运行 `codex exec --json --skip-git-repo-check --ephemeral --color never -C <workspace>`，使用隔离的 `CODEX_HOME`，不读写个人 `~/.codex`。生成专用 provider 配置与兼容 CLI 的模型目录。

- 沙箱为 `workspace-write`，默认禁止命令联网；设置可显式开启联网。
- 非交互模式 `approval_policy=never`：**Codex 不经过 Pig 的逐项写入审阅**，可直接修改选定目录。Pig 的 Docker 开关不控制 Codex 沙箱。
- 信任路径仅为工作目录的 realpath。产物采集跳过符号链接，拒绝读取越出工作目录的文件。
- 停止先向进程组发送 SIGTERM，1.5 秒后仍未退出则 SIGKILL；已取消的请求不会再启动进程。
- 每轮拼接最近的用户与助手文本；不提供 Codex 原生持久会话、完整 token 流或 skills 桥接。
- 工具事件与最终回复进入工作台。失败回到 idle，可重试本轮，不重复插入用户消息。

## 回归

`pnpm test` 包含真实固定版本 CLI + 本机 Responses 服务测试，覆盖生成配置和模型目录的实际解析。桌面冒烟也通过真实 CLI 验证连接、发送和重启后凭据恢复。真实 DeepSeek 的对话、写文件、停止后继续已单独验证，见 [完整报告](regression-2026-09-21.md)。
