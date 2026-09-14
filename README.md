# Pig Agent

纯本地、纯 Web 的 AI Agent 工作台（WorkBuddy 风格 MVP）。在浏览器里用自然语言描述目标，Agent 规划步骤、调用沙箱内的文件/命令工具，并把可审阅产物留在磁盘上。

A **pure-local, pure-web** AI agent workstation. Describe a work goal in the browser; the agent plans multi-step tasks, calls tools against a directory on disk, streams progress, and leaves reviewable artifacts. No Electron/Tauri. No mandatory cloud except the LLM endpoint you configure.

---

## 中文

### 它做什么

- **对话 / 任务**：流式回复、步骤条、实时工具调用状态、新建会话
- **产物面板**：任务中新建/修改的文件，可预览 Markdown / 文本 / 代码
- **工作区浏览器**：浏览沙箱根目录，点击预览
- **Agent 运行时**：对 OpenAI 兼容 Chat Completions 做 tool-calling 循环；工具 `list_dir` / `read_file` / `write_file` / `edit_file` / `run_shell` / `list_skills` / `load_skill`
- **技能**：`skills/*.md`（frontmatter），随仓库带了 3 个示例
- **设置**：LLM Base URL、API Key、模型、工作区根目录，持久化到本机磁盘

会话写在 `data/sessions/`，设置写在 `data/settings.json`。默认工作区是仓库内的 `sample-workspace/`。

### 快速开始

需要 [Node.js](https://nodejs.org/) 20+。推荐 pnpm（也可用 npm）。

```bash
pnpm install
pnpm dev
```

用 npm：

```bash
npm install
npm run dev
```

然后打开 **http://127.0.0.1:5173**。后端 API 在 `http://127.0.0.1:8787`（Vite 会把 `/api` 代理过去）。

### 配置 LLM

默认对接本机 **Ollama** 的 OpenAI 兼容接口：

| 项 | 默认值 |
| --- | --- |
| Base URL | `http://127.0.0.1:11434/v1` |
| API Key | `ollama`（也可留空） |
| Model | `llama3.2` |

安装并启动 Ollama 后拉取一个**支持 tool calling** 的模型，例如：

```bash
ollama pull llama3.2
# 或 qwen2.5、qwen2.5-coder 等
```

在 UI **设置** 里改 Base URL / Key / 模型即可对接任何 OpenAI 兼容网关（OpenAI、LM Studio、vLLM、LiteLLM…）。也可复制 `.env.example` 为 `.env` 作为进程级默认值；之后 UI 里保存的设置优先。

没有本机模型时，可开一个离线 mock（仍走同一套 OpenAI 兼容协议）用来看通工具调用与产物：

```bash
pnpm mock:llm
```

设置里把 Base URL 设为 `http://127.0.0.1:8788/v1`，模型填 `mock-local`。

### 工作区与沙箱

- 默认根目录：`./sample-workspace`（相对仓库根）
- 文件工具会解析并拒绝 `..`、绝对路径、指向根外的符号链接
- `run_shell` 的 cwd 固定为工作区，有超时与输出上限；明显逃逸命令会被拒绝
- **不要把工作区指到整台机器的敏感目录**

### 示例任务

1. 确认设置中的工作区是 `sample-workspace`，LLM 已指向 Ollama 或 mock。
2. 点 **新任务**，发送：

   > 请查看当前工作区，把散落的文件整理清楚，并写一份中文 README 摘要。

3. 观察中间栏的步骤与工具调用，右侧 **产物** 里打开更新后的 `README.md`。

### 技能

放在仓库 `skills/` 下，Markdown + frontmatter：

```md
---
name: my-skill
description: When to use this playbook
---

Instructions the agent should follow after load_skill.
```

自带：`organize-workspace`、`write-summary`、`daily-notes`。

### 生产向启动

```bash
pnpm build
pnpm start
```

此时后端会托管 `web/dist`，可只打开 `http://127.0.0.1:8787`。

### 测试

```bash
pnpm test
pnpm typecheck
```

手工验收见 [MANUAL_TEST.md](./MANUAL_TEST.md)。

---

## English

### What you get

A localhost workstation: chat + plan/steps, live tool status, artifacts, workspace tree, OpenAI-compatible agent loop, disk-persisted sessions/settings, and local Markdown skills. File and shell tools are sandboxed to the configured workspace root.

### Start

```bash
pnpm install && pnpm dev
```

UI: http://127.0.0.1:5173 · API: http://127.0.0.1:8787

### LLM

Defaults target **Ollama** at `http://127.0.0.1:11434/v1` (API key `ollama` or empty, model `llama3.2`). Any OpenAI-compatible Chat Completions server works — set it in **Settings** or `.env`. Prefer a model that supports tool calling.

Offline demo endpoint: `pnpm mock:llm` → `http://127.0.0.1:8788/v1`.

### Sample task

> Inspect the workspace, tidy leftover files, and write a short README summary.

Watch tool calls stream in the center pane; open the new/updated file under **Artifacts**.

### Layout

```
server/src/     Hono API, agent runtime, sandboxed tools
web/src/        React + Vite + Tailwind UI
skills/         Local skill playbooks
sample-workspace/   Default sandbox with demo files
data/           Created at runtime (sessions + settings)
```

### Security notes

Tools resolve every path against the workspace root and refuse escapes. Shell still runs on the host with `cwd=workspace` — treat the workspace as trusted-and-bounded, not as a full OS jail.

Out of scope for this MVP: cloud connectors, multi-user auth, billing, marketplaces, mobile remote control, scheduled cloud jobs.
