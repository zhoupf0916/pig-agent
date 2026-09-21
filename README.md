# Pig Agent

纯本地、纯 Web 的 AI Agent 工作台（WorkBuddy 风格）。在浏览器里用自然语言描述目标，Agent **规划 → 调工具 → 校验 → 交付产物**，文件工具访问配置的工作区；命令可选择宿主机或 Docker 容器执行。宿主机模式不提供操作系统级隔离。

A **pure-local, pure-web** AI agent workstation. Describe a work goal; the agent plans, calls sandboxed tools, verifies, and leaves reviewable artifacts. No Electron/Tauri. No mandatory cloud except the LLM endpoint you configure.

---

## 中文

### 它做什么

- **对话 / 任务**：流式回复、步骤条、带耗时的工具卡片（参数摘要 / 成功失败）、**停止**当前一轮；本机 Pig / Codex 失败可 **重试本轮**
- **产物面板**：按新建 / 修改 / 移动 / 删除分组；文本文件可看前后对比
- **工作区浏览器**：浏览沙箱根目录并预览；同一主机另一标签在回合中新建 / 修改的沙箱文件会经只读 `GET /api/workspace/tree`（焦点 / 可见 / 短轮询）跟上，已打开的预览再经只读 `GET /api/workspace/file` 跟上；另一标签删除 / 移动该文件后，已打开预览在焦点 / 可见 / 短轮询确认文件不存在后清空（不留幽灵正文），无需整页刷新
- **Agent 运行时**：OpenAI 兼容 Chat Completions 的 tool-calling 循环（`tool_choice=auto`，并行工具失败则回退）；有最大轮次、连续失败恢复、结束后的用户可见摘要
- **工具**（均限制在工作区内）：`list_dir` `read_file` `write_file` `edit_file` `apply_patch` `search_files` `delete_file` `move_file` `run_shell` `http_fetch`（SSRF 防护）`list_skills` `load_skill` `update_plan`
- **技能**：`skills/*.md`；会按任务关键词自动建议 / 预加载
- **设置**：LLM Base URL、API Key、模型、工作区。进程启动时读 `.env` / `.env.local`（已 gitignore），UI 保存优先
- **项目协作（MVP）**：`#/projects` 可建项目、待办看板、上传资产、绑定会话；项目指令注入已绑定会话的系统提示。本机轻量多用户：按显示名邀请、待接受列表、收件箱接受/拒绝、项目页兑换令牌（[docs/project-invites.md](./docs/project-invites.md)）。已绑定会话可把产物 **保存到项目**（[docs/artifacts-to-project.md](./docs/artifacts-to-project.md)）。资产可预览（文本 / Markdown / JSON / 图片）与下载，并显示来源会话；工作台或项目页可将绑定会话 **转交到收件箱**（可选附带最近产物）。见 [docs/project-assets.md](./docs/project-assets.md)。同一主机另一标签已打开该页（且打开了某项目）时，看板 / 资产 / 成员经只读 `GET /api/projects` 与 `GET /api/projects/:id`（焦点 / 可见 / 短轮询）跟上；另一标签删除该项目后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`），无需整页刷新。工作台钉选下拉的项目目录经同一 `GET /api/projects` 跟上。顶栏收件箱未读角标与列表经只读 `GET /api/inbox`（焦点 / 可见 / 短轮询）跟上；删除会话会清掉仍引用该 id 的收件箱 `sessionId`，删除项目会去掉仍引用该 id 的收件箱条目，顶栏经同一 GET 跟上（不留指向已删会话 / 项目的幽灵入口）
- **本机专家 / playbook（MVP）**：`#/experts` 目录 + 工作台钉选。内置侦察 / 规划 / 实现 / 评审；可引用 `skills/`。**专家指令先于项目指令**注入 pig / Codex / cloud-stub。`mode=chain` 小队在同一会话里顺序各跑一轮（`session.teamRun` + **顺序执行小队**）。同一主机另一标签已打开该页时，列表经只读 `GET /api/experts` 与 `GET /api/expert-teams`、已打开详情再 `GET /api/experts/:id`（焦点 / 可见 / 短轮询）跟上；另一标签删除该专家后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`），无需整页刷新。删除自定义专家 / 小队会清掉钉选该 id 的会话 `expertId` / `expertTeamId`（小队再清 `teamRun`）；已打开工作台经同一 `GET /api/sessions` 把钉选行改成「未绑定」（不留幽灵名称）。删除自定义专家还会从所有小队的 `expertIds` 去掉该 id（小队变空也不自动删）；变空的自定义小队在 `#/experts` 显示为「0 人」，可用现有 `DELETE /api/expert-teams/:id` 手动删除（内置小队仍 400）；已打开 `#/experts` 与工作台钉选目录经同一 `GET /api/expert-teams` 跟上（不留幽灵成员）。工作台钉选下拉的专家 / 小队目录经同一对 GET 跟上。技能文件从 `skills/` 消失后，`GET /api/experts` / `:id` 的 `skillIds` 不再含该名称（自定义 + 内置；只读过滤，不回写专家 JSON）；已打开 `#/experts` 经同一 GET 去掉 chip / `· id`。见 [docs/experts.md](./docs/experts.md)
- **本机自动化（MVP）**：`#/automations` 可手动或简单 cron 开一轮 pig 会话并钉选专家 / 项目。可选 `saveArtifactsToProject`（默认关）。无公网 webhook、无远程 worker。同一主机另一标签已打开该页时，列表行增删与启用 / cron / 名称以及上次运行 / 会话 / 错误经只读 `GET /api/automations`（焦点 / 可见 / 短轮询）跟上；另一标签删除该自动化后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`），无需整页刷新。删除自定义专家 / 小队或项目会清掉仍引用该 id 的自动化 `expertId` / `expertTeamId` / `projectId`；已打开 `#/automations` 经同一 GET 跟上（不留幽灵名称）。删除会话会清掉仍指向该会话的自动化 `lastSessionId`（`lastRunAt` / `lastError` / 钉选 / cron / 启用不动）；已打开 `#/automations` 经同一 GET 跟上（不留指向已删会话的幽灵入口）。见 [docs/automations.md](./docs/automations.md)
- **多端同步（MVP）**：同一会话的多个 SSE 客户端看到同一 `seq`；晚加入先拉会话快照再 `?after=` / `Last-Event-ID` 追平。断线重连只补缺口（不回放全部历史），追平中显示「正在追平未送达事件…」。侧栏对 `GET /api/sessions` 做只读刷新，同一工作站另一标签的 running→idle / 标题会跟上，无需整页刷新。已打开会话的标题 / 状态也从同一列表只读补丁跟上（不重载 transcript / 步骤）。另一标签删除该会话后，已打开的标签在焦点 / 可见 / 短轮询后清掉或切到侧栏下一会话（不拉已删会话的 transcript）。顶栏执行面 chip 对 `GET /api/settings` 做只读刷新，另一标签保存的运行时（本机 Pig / Codex / 云端）会跟上；已打开的设置弹窗同步跟上非密钥字段，正在输入的密钥不会被覆盖。设置里的 `skills/` 列表对 `GET /api/skills` 做只读刷新，另一标签增删改 `skills/*.md` 后会跟上。未发送草稿走本机 `localStorage`，同一会话另一标签经 `storage` / 焦点跟上。浅色 / 深色走本机 `pig-agent.theme`，另一标签经 `storage` / 焦点跟上。工作区树对 `GET /api/workspace/tree` 做只读刷新，已打开预览对 `GET /api/workspace/file` 做只读刷新，另一标签回合中新建 / 修改的沙箱文件会跟上；删除 / 移动已打开文件后，预览在焦点 / 可见 / 短轮询确认 404 / 不存在后清空（不留幽灵正文）。`#/automations` 列表对 `GET /api/automations` 做只读刷新，另一标签新建 / 删除 / 启用 / 改 cron / 改名或本机 cron 跑完后列表与「上次运行」/ 会话 / 错误会跟上；另一标签删除该自动化后，已打开详情在焦点 / 可见 / 短轮询确认列表没有该 id 后清掉或切走（不拉已删自动化的 `:id`）。`#/projects` 对 `GET /api/projects` 做只读刷新，已打开的项目再 `GET /api/projects/:id`，另一标签改待办 / 上传资产 / 邀请接受后看板 / 资产 / 成员会跟上；另一标签删除该项目后，已打开详情在焦点 / 可见 / 短轮询确认列表没有该 id 后清掉或切走（不拉已删项目的 `:id`）。删除会话后，仍指向该会话的项目动态 / 评论 / 转交清掉结构化 `sessionId`（正文 / 时间 / 种类不动），已打开项目详情经同一 GET 跟上；已打开的资产预览也从同一项目详情快照清掉「打开来源会话」（不拉已删会话、不关预览、不删资产文件）。另一标签删除当前高亮待办后，同一项目详情快照确认 todos 没有该 id 后清掉 `?todo=` 高亮（不另拉已删 todoId、不整页刷新）。`#/memory` 对 `GET /api/memory` 做只读刷新，已打开的笔记再 `GET /api/memory/:id`，另一标签钉住 / 编辑 / 删除或工作台写摘要后列表与详情会跟上；另一标签删除该笔记后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`）。删除项目 / 会话后，仍引用该 id 的记忆清掉对应 `projectId` / `sessionId`，已打开 `#/memory` 经同一 `GET /api/memory` 跟上（不留指向已删项目 / 会话的幽灵链接）。`#/experts` 对 `GET /api/experts` 与 `GET /api/expert-teams` 做只读刷新，已打开的专家再 `GET /api/experts/:id`，另一标签新建 / 编辑 / 删除专家或小队列表变化后列表与详情会跟上；另一标签删除该专家后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`）。删除自定义专家后，所有小队的 `expertIds` 去掉该 id（小队变空也不自动删），变空的自定义小队在 `#/experts` 显示为「0 人」并可用现有 `DELETE /api/expert-teams/:id` 手动删除（内置小队仍 400），已打开 `#/experts` 与工作台钉选目录经同一 `GET /api/expert-teams` 跟上（不留幽灵成员）。 `skills/` 里的技能文件消失后，`GET /api/experts` / `:id` 的 `skillIds` 不再含该名称（自定义 + 内置；只读过滤，不回写专家 JSON），已打开 `#/experts` 经同一 GET 去掉 chip / `· id`（不整页刷新）。不新增 `DELETE /api/skills`。工作台钉选下拉对 `GET /api/projects`、`GET /api/experts` 与 `GET /api/expert-teams` 做只读刷新，另一标签新建 / 改名 / 删除项目或专家 / 小队后目录会跟上。删除自定义专家 / 小队后，钉选该 id 的会话清掉 `expertId` / `expertTeamId`（小队再清 `teamRun`），已打开工作台经同一 `GET /api/sessions` 把钉选行改成「未绑定」。删除自定义专家 / 小队或项目后，仍引用该 id 的自动化清掉对应 `expertId` / `expertTeamId` / `projectId`，已打开 `#/automations` 经同一 `GET /api/automations` 跟上（不留幽灵名称）。删除会话后，仍指向该会话的自动化清掉 `lastSessionId`，已打开 `#/automations` 经同一 GET 跟上（不留指向已删会话的幽灵入口）。`#/search` 已有查询时对 `GET /api/search?q=` 做只读刷新，另一标签改会话标题 / 项目 / 记忆后同查询命中会跟上；另一标签删除命中的会话 / 项目 / 记忆后同查询结果会去掉该 id；软刷新前点击已删命中（404 / gone）会从当前结果 / 下拉去掉该行，不进入幽灵详情；无查询时不强制拉取。顶栏 SearchBox 已有查询且下拉打开时同样对 `GET /api/search?q=` 做只读刷新，另一标签改会话标题 / 项目 / 记忆后同查询命中会跟上，删除命中目标后同样去掉该 id；无查询或下拉关闭时不强制拉取。顶栏收件箱对 `GET /api/inbox` 做只读刷新，另一标签邀请 / 转交 / 已读 / 接受 / 忽略后角标与列表会跟上；删除会话 / 项目后，仍引用该 id 的收件箱清掉 `sessionId` 或整条项目条目，顶栏经同一 GET 跟上（不留指向已删会话 / 项目的幽灵入口）。契约见 [docs/multi-device-sync.md](./docs/multi-device-sync.md)
- **未发送草稿（本机）**：工作台输入框按 `sessionId` 写入 `localStorage`（`pig-agent.composer-drafts`）。刷新 / 重开或切换会话不会丢草稿；同一主机另一标签打开同一会话时，输入 / 清空 / 发送会经 `storage` 或焦点跟上，无需整页刷新。发送或清空只清当前会话。不写入设置或 API Key
- **本机搜索 / 记忆（MVP）**：顶栏或 `#/search` 对会话标题 / 近讯、项目名称 / 指令 / 待办 / 动态、资产文件名与文本正文、**钉住笔记 / 回合摘要**做子串检索（无向量库）。同一主机另一标签已打开 `#/search` 且已有查询时，命中列表经只读 `GET /api/search?q=`（焦点 / 可见 / 短轮询）跟上，无需整页刷新；无查询时不强制拉取。顶栏 SearchBox 已有查询且下拉打开时同样跟上；无查询或下拉关闭时不强制拉取。见 [docs/search.md](./docs/search.md)
- **可写本机记忆（MVP）**：`#/memory` 钉住事实或写启发式回合摘要，JSON 在 `data/memory/`。工作台可钉住 / 写摘要。最近若干条钉住会小剂量注入 pig 系统提示。同一主机另一标签已打开该页时，列表经只读 `GET /api/memory`、已打开详情再 `GET /api/memory/:id`（焦点 / 可见 / 短轮询）跟上；另一标签删除该笔记后，已打开详情在列表确认没有该 id 后清掉或切走（不拉 `:id`），无需整页刷新。删除项目 / 会话会清掉仍引用该 id 的记忆 `projectId` / `sessionId`（正文 / 标签不动）；已打开 `#/memory` 经同一 GET 跟上（不留幽灵链接）。见 [docs/memory.md](./docs/memory.md)

会话写在 `data/sessions/`，项目写在 `data/projects/`，专家写在 `data/experts/`，自动化写在 `data/automations/`，记忆写在 `data/memory/`，设置写在 `data/settings.json`。默认工作区是仓库内的 `sample-workspace/`。

这是协作 + 同步 + 本机专家 + 本机自动化 + 本机搜索 + 可写记忆的 **第一刀**，不是完整 neo-cloud-agent：没有 Desk Remote、Firecracker、Java Agent loop、管理台、专家市场、公网 webhook、向量记忆。默认运行时仍是 **pig**；已有 **codex** 与 **cloud**（local-stub / remote）保持可用。顶栏与设置会标出当前执行面（Pig / Codex / 云端含 remote URL）；本机 Pig 密钥/网关/工具失败、本机 Codex 缺二进制/启动失败/会话出错给出可读中文原因并可 **重试本轮**（不重复插入用户消息，会话回到 idle）；远程断连 / 超时 / 过期给出可读中文原因并可重试（继续跟进或重新创建运行），停止后下一轮不会僵尸。

### 可审阅的任务交付

本机 Pig 新增 **执行与验收** 抽屉：目标目录与命令环境确认、写入前差异审阅、逐项批准／拒绝、文件快照撤销、磁盘结果核验、上传资料、保留工具历史继续任务、用量与预算、Docker 命令运行、内置及自定义任务模板。新任务默认先审阅后写入；批准后点“继续任务”完成后续验证。

详见 [交付链路与验收步骤](./docs/delivery-loop.md)。这些增强当前针对 Pig；不改变 Codex / 远程 Cloud 的执行协议。

### 快速开始

环境要求：Node.js 22.13+（建议 24）和 pnpm 11.19.0。仓库通过 `packageManager` 固定 pnpm 版本；`pnpm-workspace.yaml` 只允许 esbuild 的依赖构建脚本。

使用上述 Node.js 与 pnpm 版本以保持本地与 CI 一致。

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

安装 `@openai/codex` **0.154.x**（或兼容的 CLI），在设置中选择 Codex，发一条「写一个文件」即可看到工具卡片与产物。启动时工作台在现有步骤条上显示中文进度（准备 Codex 环境 → 启动 Codex 进程），首个工具卡片或助手消息后清空。多轮只拼接最近若干条用户/助手文本，**没有 Codex 原生跨轮记忆**。缺少二进制、启动失败或本轮会话出错时给出可读中文原因并可 **重试本轮**，会话回到 idle。

已知缺口（刻意不做）：skills 桥、update_plan/步骤条、细粒度 token 流、danger-full-access。详见 [docs/codex-runtime.md](./docs/codex-runtime.md)。仓库里只有 [examples/codex/](./examples/codex/) 模板，不要提交真实密钥。

### 可选：云端执行面

默认仍是 **本机 Pig**。设置里可把运行时切到 **云端**（与 Codex 一样是 opt-in）。工作台会话 / 计划 / 工具 / 产物语义不变，只换执行面。

| 项 | 默认 / 要求 |
| --- | --- |
| 运行时 | `pig`（不选云端则行为与以前完全一致） |
| `cloudMode` | `local-stub`：在 `data/cloud-runs/<id>/` 隔离工作区副本上跑本机 Pig 循环 |
| 远程 | `remote` + 控制面 origin；`POST /v1/runs`（工作区 snapshot / 可选 repo hint）→ SSE → IDLE follow-up / abort；失败可重试 |
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

测试文件各自使用临时数据目录，不读取开发者的 `.env` / `.env.local`，不改写日常使用的 `data/settings.json`。macOS 临时目录会规范化，默认并行执行即可。

GitHub Actions 会在 PR 和 main 更新时执行锁文件安装、全量测试、类型检查与生产构建。

```bash
pnpm test
pnpm typecheck
```

手工验收见 [MANUAL_TEST.md](./MANUAL_TEST.md)。

---

## English

### What you get

A localhost workstation: chat + plan/steps, live tool cards (args, ok/fail, duration), stoppable runs, grouped artifacts with text diffs, workspace tree (same-host tabs refresh via read-only `GET /api/workspace/tree` on focus / visibility / a short poll; an already-open file preview refreshes via `GET /api/workspace/file`, and clears empty when that path is deleted or moved), OpenAI-compatible agent loop (DeepSeek-friendly tool calling), disk-persisted sessions/settings, per-session unsent composer drafts in `localStorage` (never Settings/API keys; same-host tabs stay in sync via `storage` / focus), light/dark theme in `pig-agent.theme` (same-host tabs follow via `storage` / focus), and local Markdown skills with keyword auto-load. File, shell, and HTTP tools stay sandboxed / SSRF-safe.

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
data/           Created at runtime (sessions, projects, experts, automations, memory, settings) — gitignored
```

### Security notes

Tools resolve every path against the workspace root and refuse escapes. Shell still runs on the host with `cwd=workspace` — treat the workspace as trusted-and-bounded, not as a full OS jail. `http_fetch` blocks private IPs and redirects.

Optional **Codex** backend: Settings → runtime `codex` runs `codex exec --json` with an isolated `CODEX_HOME`, `wire_api=responses`, DeepSeek `deepseek-flash`, `approval_policy=never`, and `network_access=false` unless you explicitly opt in. While Codex env sync / process spawn is in flight the workbench shows Chinese step-strip progress (准备 Codex 环境 → 启动 Codex 进程), mutually exclusive with create-run / follow-up / local-stub chips; the first tool card or assistant message clears them. Pig `llmBaseUrl` (`…/v1`) is never copied into the Codex provider. Missing binary / start failure / session errors show a readable Chinese reason and **重试本轮**; the session returns to idle. See [docs/codex-runtime.md](./docs/codex-runtime.md).

Optional **cloud** execution surface: Settings → runtime `cloud` (default `cloudMode=local-stub`) runs the pig loop against `data/cloud-runs/<id>/` and emits the same `AgentEvent`s. While local-stub isolate materialize is in flight the workbench shows Chinese step-strip progress (准备隔离工作区 → 启动本机循环). Remote mode talks create-run (workspace snapshot / optional repo hint / sanitized `environment.json` install hints) → SSE → IDLE follow-up / abort. While create-run is in flight the workbench shows Chinese step-strip progress (snapshot / create / subscribe); an existing `remoteRunId` follow-up / event-stream reconnect shows 继续跟进 / 重新连接事件流. The first pig token/tool (local-stub) or stream event (remote) clears those bootstrap chips. Disconnect / timeout / expired run show a readable Chinese reason and **Retry** (follow-up or new create-run); abort returns idle so the next send is not a zombie. Non-secret host hints (control-plane URL, repo URL / ref) can live in `env.json` (`env.json.example`). Worker/local prep hints (install / deps / tools / setup) live in Cursor-style `environment.json` (`environment.json.example`) and are shipped on create-run or read from the snapshot — never provider keys. Precedence for host hints: Settings/UI → `env.json` → `PIG_CLOUD_*`. Tokens stay in `.env.local` / Settings. `pnpm mock:cloud` is the in-repo plane. See [docs/cloud-runtime.md](./docs/cloud-runtime.md).

Collaboration + multi-tab sync is an MVP (projects JSON under `data/projects/`, per-session event JSONL). A dropped SSE reconnects with `after` / `Last-Event-ID` and replays only the gap. The session sidebar polls `GET /api/sessions` so another same-host tab’s running→idle status (and title) updates without a full reload. The already-open session’s title / status also patches from that list without reloading the transcript. If another same-host tab deletes that session, the open tab clears or switches to the next sidebar session on focus / visibility / a short poll (no transcript fetch of the deleted row). The open session’s 项目 / 专家 / 小队 pin row reuses that list so another tab’s bind / 「未绑定」 updates without a full reload. Deleting a custom expert / team clears `expertId` / `expertTeamId` (and `teamRun` for the team) on sessions that pinned that id; the already-open pin row follows the same `GET /api/sessions` list to 「未绑定」 (no ghost name). Deleting a custom expert / team or a project also clears matching `expertId` / `expertTeamId` / `projectId` on automations that still named that id; an already-open `#/automations` page follows the same `GET /api/automations` list (no ghost name). Deleting a session clears `lastSessionId` on automations that still named that session (`lastRunAt` / `lastError` / pins / cron / enabled stay); an already-open `#/automations` page follows the same GET (no ghost link into the deleted session). Those dropdown catalogs poll `GET /api/projects` + `GET /api/experts` + `GET /api/expert-teams` so another tab’s create / rename / delete updates the option lists without a full reload. The top-bar runtime chip polls `GET /api/settings` so another tab’s saved execution surface (本机 Pig / Codex / 云端) updates without a full reload. An already-open Settings modal applies the same snapshot to non-secret form fields (in-progress API key / token inputs stay put). The Settings `skills/` list polls `GET /api/skills` so another tab’s add / edit / delete of `skills/*.md` updates without a full reload. Unsent composer drafts stay in `localStorage`; another same-host tab on the same session follows typing / clear / send via the `storage` event or focus / visibility. Named local invites can be accepted, declined, revoked, or redeemed by token on one Pig host ([docs/project-invites.md](./docs/project-invites.md)). Bound sessions can copy artifacts into project assets ([docs/artifacts-to-project.md](./docs/artifacts-to-project.md)). Project assets can be previewed (text / Markdown / JSON / image) and downloaded, and a bound session can be handed off into the project inbox (optional recent artifacts) — see [docs/project-assets.md](./docs/project-assets.md). Another same-host tab already on `#/projects` with a project open polls `GET /api/projects` (and `GET /api/projects/:id` for that open detail) so board / assets / members update without a full reload; if another tab deletes that project, the open tab clears or switches away on focus / visibility / a short poll once the list lacks that id (no `GET /api/projects/:id` after the list confirms it is gone). Deleting a session clears `sourceSessionId` on project assets and `sessionId` on project todos and project messages (activity / comment / handoff) that still named that session (title / status / body / kind / timestamp stay); an already-open project detail follows the same GET (no clickable source-session into the deleted session). An already-open asset preview also patches matching asset fields from that same project-detail snapshot so 「打开来源会话」 disappears (no GET of the deleted session, preview stays open, the file is not deleted). If another tab deletes the highlighted todo, the same project-detail snapshot clears the `?todo=` highlight once that id is absent from todos (no GET of the deleted todo id, no full reload). Local experts are JSON playbooks under `data/experts/` (see [docs/experts.md](./docs/experts.md)); expert text precedes project text in the system prompt. A pinned `mode=chain` team runs members as sequential same-session pig turns (`POST /api/sessions/:id/team-run`). Local automations (`data/automations/`, `#/automations`) can manually or on a simple cron start a pig session with pinned expert/project — optional `saveArtifactsToProject` (default off); no public webhooks. Another same-host tab already on `#/automations` polls `GET /api/automations` so create / delete / enable / cron / name and last-run / session / error update without a full reload; if another tab deletes that automation, the open tab clears or switches away on focus / visibility / a short poll once the list lacks that id (no `GET /api/automations/:id` after the list confirms it is gone; see [docs/automations.md](./docs/automations.md)). Local search (`GET /api/search`, header / `#/search`) is substring/token match over session transcripts, project records, and writable memory notes — no embeddings ([docs/search.md](./docs/search.md)). Another same-host tab already on `#/search` with a query polls `GET /api/search?q=` so title / project / memory edits catch up without a full reload; if another tab deletes a hit session / project / memory the same-query snapshot drops that id; clicking a stale hit before that refresh (404 / gone) removes the row and does not open a ghost detail; no query → no force-fetch. The header SearchBox does the same when a query is present and the dropdown is open; no query or dropdown closed → no force-fetch. Pins / recaps live under `data/memory/` (`#/memory`); recent pins inject into the pig system prompt only ([docs/memory.md](./docs/memory.md)). Another same-host tab already on `#/memory` polls `GET /api/memory` (and `GET /api/memory/:id` when that note is open) so pin / edit / delete / write-summary catch up without a full reload; if another tab deletes that note, the open tab clears or switches away on focus / visibility / a short poll once the list lacks that id (no `GET /api/memory/:id` after the list confirms it is gone). Deleting a project / session clears matching `projectId` / `sessionId` on notes that still named that id; an already-open `#/memory` page follows the same `GET /api/memory` list (no ghost link into the deleted project / session). Another same-host tab already on `#/experts` polls `GET /api/experts` plus `GET /api/expert-teams` (and `GET /api/experts/:id` when that expert is open) so create / edit / delete / team-list catch up without a full reload; if another tab deletes that expert, the open tab clears or switches away on focus / visibility / a short poll once the list lacks that id (no `GET /api/experts/:id` after the list confirms it is gone). Deleting a custom expert also drops that id from every team's `expertIds` (empty teams stay); empty custom teams stay listed as 「0 人」 and can be removed with the existing `DELETE /api/expert-teams/:id` (bundled teams stay 400; empty teams are not auto-deleted); an already-open `#/experts` team list and workbench pin-dropdown catalogs follow the same `GET /api/expert-teams` snapshot (no ghost member). After a skill file vanishes from `skills/`, `GET /api/experts` / `:id` drop that name from `skillIds` (custom + built-in; read-time filter, no write-back). An already-open `#/experts` page drops the chip / `· id` via the same AC GET. No `DELETE /api/skills`. The header inbox polls `GET /api/inbox` so another same-host tab’s invite / transfer / read / accept / ignore updates the badge and list without a full reload. Deleting a session clears `sessionId` on inbox items that still named that session; deleting a project removes inbox rows for that `projectId`; the same GET drops ghost open-session / open-project entries. Not full neo-cloud-agent: no Desk Remote, Firecracker, Java loop, admin platform, experts marketplace, or public webhooks.

Out of scope: Electron, Tencent connectors, cloud multi-tenant hosting, billing, Expert marketplace, Codex skills bridge / token streaming / danger-full-access, neo-cloud-agent control-plane / Firecracker / Java loop. Do not commit real API keys.
