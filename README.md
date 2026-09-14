# Pig Agent

纯本地、纯 Web 的 AI Agent 工作台（WorkBuddy 风格）。在浏览器里用自然语言描述目标，Agent **规划 → 调工具 → 校验 → 交付产物**，文件与命令只作用于本机沙箱工作区。

A **pure-local, pure-web** AI agent workstation. Describe a work goal; the agent plans, calls sandboxed tools, verifies, and leaves reviewable artifacts. No Electron/Tauri. No mandatory cloud except the LLM endpoint you configure.

---

## 中文

### 它做什么

- **对话 / 任务**：流式回复、步骤条、带耗时的工具卡片（参数摘要 / 成功失败）、**停止**当前一轮
- **产物面板**：按新建 / 修改 / 移动 / 删除分组；文本文件可看前后对比
- **工作区浏览器**：浏览沙箱根目录并预览
- **Agent 运行时**：OpenAI 兼容 Chat Completions 的 tool-calling 循环（`tool_choice=auto`，并行工具失败则回退）；有最大轮次、连续失败恢复、结束后的用户可见摘要
- **工具**（均限制在工作区内）：`list_dir` `read_file` `write_file` `edit_file` `apply_patch` `search_files` `delete_file` `move_file` `run_shell` `http_fetch`（SSRF 防护）`list_skills` `load_skill` `update_plan`
- **技能**：`skills/*.md`；会按任务关键词自动建议 / 预加载
- **设置**：LLM Base URL、API Key、模型、工作区。进程启动时读 `.env` / `.env.local`（已 gitignore），UI 保存优先
- **项目协作（MVP）**：`#/projects` 可建项目、待办看板、上传资产、绑定会话；项目指令注入已绑定会话的系统提示。本机单用户 + 占位邀请令牌 / 收件箱
- **本机专家 / playbook（MVP）**：`#/experts` 目录 + 工作台钉选。内置侦察 / 规划 / 实现 / 评审；可引用 `skills/`。**专家指令先于项目指令**注入 pig / Codex / cloud-stub。见 [docs/experts.md](./docs/experts.md)
- **多端同步（MVP）**：同一会话的多个 SSE 客户端看到同一 `seq`；晚加入先拉会话快照再 `?after=` / `Last-Event-ID` 追平。契约见 [docs/multi-device-sync.md](./docs/multi-device-sync.md)

会话写在 `data/sessions/`，项目写在 `data/projects/`，专家写在 `data/experts/`，设置写在 `data/settings.json`。默认工作区是仓库内的 `sample-workspace/`。

这是协作 + 同步 + 本机专家的 **第一刀**，不是完整 neo-cloud-agent：没有 Desk Remote、Firecracker、Java Agent loop、管理台、专家市场。默认运行时仍是 **pig**；已有 **codex** 与 **cloud**（local-stub / remote）保持可用。

### 快速开始

需要 [Node.js](https://nodejs.org/) 20+。推荐 pnpm（也可用 npm）。

```bash
pnpm install
pnpm dev
```

然后打开 **http://127.0.0.1:5173**。后端 API 在 `http://127.0.0.1:8787`（Vite 把 `/api` 代理过去）。

### 配置 DeepSeek（推荐）

默认对接 **DeepSeek** 的 OpenAI 兼容接口（已验证本仓库的 tool-calling 循环可用）：

| 项 | 默认值 |
| --- | --- |
| Base URL | `https://api.deepseek.com/v1` |
| Model | `deepseek-chat` |
| API Key | 环境变量，见下 |

1. 复制环境文件（**只放占位符到 git**；真密钥只写本机）：

   ```bash
   cp .env.example .env.local
   ```

2. 在 `.env.local` 里填入（三选一，前者优先）：

   ```bash
   DEEPSEEK_API_KEY=sk-...
   # 或 OPENAI_API_KEY=...
   # 或 LLM_API_KEY=...
   LLM_BASE_URL=https://api.deepseek.com/v1
   LLM_MODEL=deepseek-chat
   ```

3. 重启 `pnpm dev`。也可在 UI **设置** 里覆盖 Base URL / Key / 模型（写入本机 `data/settings.json`）。

`.env`、`.env.local`、`data/` **不要提交**。仓库里的 `.env.example` 只有占位符。

也可用任何 OpenAI 兼容网关（OpenAI、Ollama、LM Studio、vLLM、LiteLLM）：

| 提供方 | Base URL | 备注 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | 模型 `deepseek-chat` |
| Ollama | `http://127.0.0.1:11434/v1` | 需支持 tool calling 的模型 |
| OpenAI | `https://api.openai.com/v1` | 用 `OPENAI_API_KEY` |

### 可选：Codex 运行时

默认仍是 **pig**（上面的 Chat Completions 循环）。设置里可把运行时切到 **codex**，此时后端走隔离的 `CODEX_HOME` 并执行 `codex exec --json`（stdin 关闭，`approval_policy=never`），再映射成现有的 `AgentEvent` SSE。

| 项 | 默认 / 要求 |
| --- | --- |
| 运行时 | `pig`（不选 Codex 则行为与以前完全一致） |
| Codex 沙箱 | `workspace-write`，**`network_access=false`**（外网需在设置里显式勾选，有警告） |
| 模型 | `deepseek-flash`（Responses API；`wire_api=chat` 会被现代 Codex 拒绝） |
| Provider URL | `https://api.deepseek.com/`（**不会**把 pig 的 `llmBaseUrl` `…/v1` 映射进去） |
| 密钥 | 只用环境变量 `DEEPSEEK_API_KEY` / `CODEX_API_KEY` |
| 工作区信任 | 仅 `realpath(workspaceRoot)`，切换工作区会重写 `[projects."…"]` |
| 中止 | 杀进程组，1.5s 后 SIGKILL |

安装 `@openai/codex` **0.154.x**（或兼容的 CLI），在设置中选择 Codex，发一条「写一个文件」即可看到工具卡片与产物。多轮只拼接最近若干条用户/助手文本，**没有 Codex 原生跨轮记忆**。

已知缺口（刻意不做）：skills 桥、update_plan/步骤条、细粒度 token 流、danger-full-access。详见 [docs/codex-runtime.md](./docs/codex-runtime.md)。仓库里只有 [examples/codex/](./examples/codex/) 模板，不要提交真实密钥。

### 可选：云端执行面

默认仍是 **本机 Pig**。设置里可把运行时切到 **云端**（与 Codex 一样是 opt-in）。工作台会话 / 计划 / 工具 / 产物语义不变，只换执行面。

| 项 | 默认 / 要求 |
| --- | --- |
| 运行时 | `pig`（不选云端则行为与以前完全一致） |
| `cloudMode` | `local-stub`：在 `data/cloud-runs/<id>/` 隔离工作区副本上跑本机 Pig 循环 |
| 远程 | `remote` + 控制面 origin；`POST /v1/runs`（工作区 snapshot / 可选 repo hint）→ SSE → IDLE follow-up / abort |
| 密钥 | 留在本机控制路径 / 未来 Gateway；**不会**写入 run 目录、snapshot 或提交 git |

`local-stub` 让 `pnpm test` 和离线 mock 不需要集群。远程 follow-up 可用 `pnpm mock:cloud`（`http://127.0.0.1:8080`）对着契约冒烟。详见 [docs/cloud-runtime.md](./docs/cloud-runtime.md)。

没有可用模型时，可开离线 mock（同一套协议，用来看工具与产物）：

```bash
pnpm mock:llm
```

设置里把 Base URL 设为 `http://127.0.0.1:8788/v1`，模型填 `mock-local`。

### 工作区与沙箱

- 默认根目录：`./sample-workspace`（相对仓库根）
- 文件工具会解析并拒绝 `..`、绝对路径、指向根外的符号链接
- `run_shell` 的 cwd 固定为工作区；捕获 exit code；截断 stdout/stderr；拒绝明显逃逸 / 危险命令；不会把 API Key 传给子进程
- `http_fetch` 只允许 http(s)，阻止私网/回环 IP、带凭证 URL 和重定向；可设 `HTTP_FETCH_ALLOWLIST`
- **不要把工作区指到整台机器的敏感目录**。这是本机单用户工作台，不是多租户云。

### 示例任务

1. 确认设置中的工作区是 `sample-workspace`，LLM 已指向 DeepSeek（或 mock）。
2. 点 **新任务**，发送：

   > 请搜索工作区里的笔记，把散落文件整理好，并写一份中文调研报告。

3. 观察中间栏的步骤与工具卡片（可点 **停止**），右侧 **产物** 里打开新建/修改的文件，需要时切换「对比」。

### 技能

放在仓库 `skills/` 下，Markdown + frontmatter（可用 `keywords` 做自动匹配）：

```md
---
name: my-skill
description: When to use this playbook
keywords: research, 报告
---

Instructions the agent should follow after load_skill.
```

自带：`organize-workspace`、`write-summary`、`daily-notes`、`doc-writing`、`data-cleanup`、`research-report`、`coding-helper`。

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

A localhost workstation: chat + plan/steps, live tool cards (args, ok/fail, duration), stoppable runs, grouped artifacts with text diffs, workspace tree, OpenAI-compatible agent loop (DeepSeek-friendly tool calling), disk-persisted sessions/settings, and local Markdown skills with keyword auto-load. File, shell, and HTTP tools stay sandboxed / SSRF-safe.

### Start

```bash
cp .env.example .env.local   # put DEEPSEEK_API_KEY there — never commit it
pnpm install && pnpm dev
```

UI: http://127.0.0.1:5173 · API: http://127.0.0.1:8787

### LLM

Defaults: **DeepSeek** `https://api.deepseek.com/v1`, model `deepseek-chat`. Keys from `LLM_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` in `.env` or `.env.local`. Settings UI overrides. Offline mock: `pnpm mock:llm` → `http://127.0.0.1:8788/v1`.

### Sample task

> Search the messy workspace, reorganize leftover files, and write a short research report.

Watch tool cards in the center pane; open artifacts on the right. Hit **Stop** to cancel a turn.

### Layout

```
server/src/     Hono API, agent runtime, sandboxed tools
web/src/        React + Vite + Tailwind UI
skills/         Local skill playbooks
sample-workspace/   Default sandbox with demo files
data/           Created at runtime (sessions, projects, experts, settings) — gitignored
```

### Security notes

Tools resolve every path against the workspace root and refuse escapes. Shell still runs on the host with `cwd=workspace` — treat the workspace as trusted-and-bounded, not as a full OS jail. `http_fetch` blocks private IPs and redirects.

Optional **Codex** backend: Settings → runtime `codex` runs `codex exec --json` with an isolated `CODEX_HOME`, `wire_api=responses`, DeepSeek `deepseek-flash`, `approval_policy=never`, and `network_access=false` unless you explicitly opt in. Pig `llmBaseUrl` (`…/v1`) is never copied into the Codex provider. See [docs/codex-runtime.md](./docs/codex-runtime.md).

Optional **cloud** execution surface: Settings → runtime `cloud` (default `cloudMode=local-stub`) runs the pig loop against `data/cloud-runs/<id>/` and emits the same `AgentEvent`s. Remote mode talks create-run (workspace snapshot / optional repo hint) → SSE → IDLE follow-up / abort. `pnpm mock:cloud` is the in-repo plane. Provider keys stay on the host control path. See [docs/cloud-runtime.md](./docs/cloud-runtime.md).

Collaboration + multi-tab sync is an MVP (projects JSON under `data/projects/`, per-session event JSONL). Local experts are JSON playbooks under `data/experts/` (see [docs/experts.md](./docs/experts.md)); expert text precedes project text in the system prompt. Not full neo-cloud-agent: no Desk Remote, Firecracker, Java loop, admin platform, or experts marketplace.

Out of scope: Electron, Tencent connectors, cloud multi-tenant hosting, billing, Expert marketplace, Codex skills bridge / token streaming / danger-full-access, neo-cloud-agent control-plane / Firecracker / Java loop. Do not commit real API keys.
