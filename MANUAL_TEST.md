# Manual test checklist

Use this after `pnpm install && pnpm dev`. UI is http://127.0.0.1:5173.

## Smoke (no LLM required)

- [ ] Page loads: left sessions, center chat, right artifacts/workspace
- [ ] **Settings** shows DeepSeek defaults (`https://api.deepseek.com/v1`, model `deepseek-chat`) and runtime **Pig** unless `.env.local` / saved settings override
- [ ] Change a field, save, reload — values persist
- [ ] Right panel **工作区** lists `notes/`, `drafts/`, `scattered-log.txt`, `README.md`
- [ ] Click `notes/meeting-2026-03-14.md` — Markdown preview renders
- [ ] Click `notes/todo.txt` — plain text preview
- [ ] **新任务** creates a session; delete icon removes it
- [ ] `GET /api/health` → `{ ok: true }`
- [ ] `POST /api/workspace/resolve` with `{ "path": "../package.json" }` → 400 / escape error

## Agent path (DeepSeek or mock)

- [ ] `.env.local` has `DEEPSEEK_API_KEY` **or** `pnpm mock:llm` and Settings Base URL `http://127.0.0.1:8788/v1`
- [ ] New session, send: `搜索笔记，整理散落文件，并写一份中文调研报告`
- [ ] Tokens stream (real model) or a final assistant message appears (mock)
- [ ] Step chips and tool cards show args, 成功/失败, duration
- [ ] **产物** groups 新建 vs 修改; opening a modified file can show **对比**
- [ ] Assistant ends with a user-facing summary of what changed
- [ ] **停止** while running returns the session to idle (real model, longer run)

## Sandbox / SSRF

- [ ] Ask the agent to `read /etc/passwd` or `write ../outside.md` — tool result is a sandbox error, no file outside the workspace
- [ ] `http_fetch` to `http://127.0.0.1/` is blocked
- [ ] Automated coverage: `pnpm test` (path traversal, symlink hop, shell reject, SSRF, mock DeepSeek tool loop, failed-tool recovery)

## Skills

- [ ] Settings lists `organize-workspace`, `write-summary`, `daily-notes`, `doc-writing`, `data-cleanup`, `research-report`, `coding-helper`
- [ ] A matching ask (调研报告 / 整理 / 代码 patch) auto-suggests the skill in the system prompt; capable models may also `load_skill`

## Codex runtime (optional)

- [ ] Settings default runtime is **Pig**; existing pig smoke still works with Codex left off
- [ ] Switch to **Codex**：binary path optional, model `deepseek-flash`, network toggle default off
- [ ] Enabling outbound network shows the amber warning
- [ ] With `@openai/codex` 0.154.x on PATH and `DEEPSEEK_API_KEY` in `.env.local`, new session: `请在工作区写一个 hello-codex.md，内容为 ok`
- [ ] Tool cards (shell / apply_patch) and an assistant summary appear; **产物** lists the new file
- [ ] Reload the session — tool cards remain (synthetic tool messages persisted)
- [ ] **停止** kills the Codex process group
- [ ] Changing workspace rewrites isolated `data/codex-home/config.toml` `[projects."<realpath>"]` only

## Cloud runtime (optional)

Default runtime stays **本机 Pig**. Cloud is opt-in, like Codex. See [docs/cloud-runtime.md](./docs/cloud-runtime.md).

- [ ] Settings shows three surfaces: **本机 Pig（默认）** / **本机 Codex（可选）** / **云端（可选）**
- [ ] Switch to **云端**：mode defaults to `local-stub`; Base URL / token optional
- [ ] Header hint reads `云端 · local-stub` (or the remote host when mode is remote)
- [ ] `pnpm mock:llm`, Settings Pig Base URL `http://127.0.0.1:8788/v1`, runtime **云端** / local-stub
- [ ] New session: `请写一个 hello-cloud.md，内容为 ok` — step chips + tool cards + **产物** list the file (stub copies into `data/cloud-runs/<id>/workspace/` then syncs back)
- [ ] `data/cloud-runs/<id>/run.json` has no API keys; isolated copy has no `.env`
- [ ] **停止** while the stub is running returns idle (same control as Pig)
- [ ] Remote mode without a URL refuses to save (`Cloud base URL is required`)
- [ ] Do **not** put `DEEPSEEK_API_KEY` into a worker env file or commit it
- [ ] `pnpm mock:cloud` listens on `http://127.0.0.1:8080` (no provider key, no cluster)
- [ ] Settings → 云端 → remote → Base URL `http://127.0.0.1:8080`. New session: `请整理工作区` — assistant text mentions `accepted workspace` and lists uploaded files (not `.env`)
- [ ] Same session, second message `再写一个文件` — reply is `[stub] follow-up: …`. `data/sessions/<id>.json` keeps the same `remoteRunId`
- [ ] Isolated snapshot never includes `.env*`, `id_rsa` / `*.pem`, `node_modules`, or `.git` (see [docs/cloud-runtime.md](./docs/cloud-runtime.md))

## Projects + multi-tab sync (Milestone A)

No LLM required for the project surface. Sync live tokens still need a model or `pnpm mock:llm`.

- [ ] Header shows **工作台** / **项目** / **收件箱**. Default runtime is still **本机 Pig**
- [ ] Open `#/projects`, create a project, write an instruction, add a todo, upload a small text asset
- [ ] **在此项目开任务** creates a session bound to the project; chat header shows the project name
- [ ] Invite generates a placeholder token and an unread inbox item; mark read from the inbox menu
- [ ] `GET /api/projects` lists the project; `GET /api/inbox` shows the invite
- [ ] Two tabs on the same session: tab B does not need a full reload to stay consistent. Or with curl:
  1. `POST /api/sessions` → `id`
  2. Open two terminals: `curl -N http://127.0.0.1:8787/api/sessions/<id>/events`
  3. In a third terminal publish via a running turn, **or** inspect `data/sessions/<id>/events.jsonl` after sending a message
  4. `curl 'http://127.0.0.1:8787/api/sessions/<id>/events?after=1&live=0'` returns seq > 1
- [ ] Re-open the session (or reconnect SSE) after another tab advanced it — transcript matches without refresh-from-scratch
- [ ] This is **not** Desk Remote / Firecracker / experts marketplace

## Local experts / playbooks (Milestone C)

No LLM required for the directory. Prompt injection is covered by `pnpm test`.

- [ ] Header shows **工作台** / **项目** / **专家**. Default runtime is still **本机 Pig**
- [ ] Open `#/experts` — bundled **侦察 Scout** / **规划 Plan** / **实现 Implement** / **评审 Review** and team **编码流水线** are listed
- [ ] Create a custom expert, edit its instruction, reload — JSON persists under `data/experts/`
- [ ] **绑定到当前会话** (or the workstation **专家** select) sets `session.expertId`; hint reads 专家指令将注入 / 先于项目指令
- [ ] Bind a project **and** an expert — precedence is expert then project (see [docs/experts.md](./docs/experts.md))
- [ ] `GET /api/experts` lists bundled ids `exp_scout` … `exp_review`; `GET /api/expert-teams` includes `team_coding`
- [ ] `DELETE /api/experts/exp_scout` → 400 (bundled). Custom experts can be deleted
- [ ] Implement expert lists skill `coding-helper` (local `skills/`, not a marketplace)
- [ ] Workstation cards (bubbles, tool cards, artifacts) are unchanged aside from the pin row
- [ ] This is **not** an expert marketplace, Cordis, Desk Remote, or Firecracker

## Local automations (Milestone D)

No public webhooks. The in-process scheduler starts with `pnpm dev` / `pnpm start` (not with `createApp()` in unit tests). See [docs/automations.md](./docs/automations.md).

- [ ] Header shows **工作台** / **项目** / **专家** / **自动化**. Default runtime is still **本机 Pig**
- [ ] Open `#/automations`, create an automation with a prompt, leave schedule empty (manual-only)
- [ ] Optionally pin an expert and/or project, toggle **启用**
- [ ] **立即运行** creates a new session, opens the workstation, and shows the prompt as the first user message
- [ ] `data/automations/<id>.json` has `runtime: "pig"`, `lastSessionId`, `lastRunAt`; no API keys
- [ ] Set schedule `@hourly` or `@daily` (or `0 9 * * 1`); invalid cron is rejected
- [ ] Click **立即运行** twice quickly — second request is skipped / 409 while the first is in flight
- [ ] `GET /api/automations` lists the record; `POST /api/automations/:id/run` returns 202 + session
- [ ] This is **not** Slack/Telegram ingress, remote workers, Desk Remote, or Firecracker

## Artifacts → project assets (Milestone E)

No LLM required if you seed an artifact (or finish a mock/real turn that writes a file). See [docs/artifacts-to-project.md](./docs/artifacts-to-project.md).

- [ ] Bind a session to a project (chat header project select or **在此项目开任务**)
- [ ] After the session has a created/modified artifact, the right **产物** panel shows **保存到项目** (unbound sessions do not)
- [ ] Click **保存到项目** — toast + **查看资产** opens `#/projects/<id>`; the file is listed (filename + 来自 `<path>`)
- [ ] Click again — same asset id is overwritten (not a second copy)
- [ ] `POST /api/sessions/<id>/artifacts/<urlencoded-path>/save-to-project` returns `{ asset, overwritten }`
- [ ] `POST /api/sessions/<id>/artifacts/save-all-to-project` copies savable files and skips deleted
- [ ] Unbound session → 400 `Session is not bound to a project`
- [ ] Automations: pin a project, leave **运行成功后把新产物保存到项目资产** unchecked (default) — a run does not add assets
- [ ] Check the box, run a turn that writes a file — project assets include that path
- [ ] Default runtime is still **本机 Pig**. This is **not** Desk Remote / Firecracker / marketplace

## Asset preview + session handoff (Milestone F)

No LLM required. See [docs/project-assets.md](./docs/project-assets.md).

- [ ] Open `#/projects`, upload a Markdown (or JSON) file — list shows filename + size
- [ ] Click **预览** — modal renders Markdown / pretty JSON; Escape closes
- [ ] Click **下载** — browser saves the original bytes
- [ ] After **保存到项目** from a bound session, the asset shows **来自 `<path>`** and **来源会话** opens that session
- [ ] Upload a small PNG — preview shows the image
- [ ] Bound session on the project page: **转交** → note + optional recent artifacts → inbox has a 转交 item
- [ ] Workstation with a pinned project: **转交到收件箱** does the same; inbox **打开会话** returns to the workstation
- [ ] `GET /api/projects/<id>/assets/<assetId>` returns `{ kind, content }`
- [ ] `GET /api/projects/<id>/assets/<assetId>/download` is `Content-Disposition: attachment`
- [ ] `POST /api/projects/<id>/handoffs` with `{ sessionId, note, attachRecentArtifacts: true }` → 201 + inbox `kind=handoff` (and `assetIds` when files were copied)
- [ ] Default runtime is still **本机 Pig**. This is **not** Desk Remote / Firecracker / marketplace

## Local search / memory (Milestone G)

No LLM required. No embeddings. See [docs/search.md](./docs/search.md).

- [ ] Header shows a search box (desktop) and a **搜索** nav item. Default runtime is still **本机 Pig**
- [ ] Open `#/search`, type a unique phrase from a session title or recent user/assistant message — a **会话** hit appears
- [ ] Click the session hit — workstation opens that transcript (`#/sessions/<id>`)
- [ ] Search a project name / instruction / todo / comment — typed hits navigate to `#/projects/<id>` (todo is highlighted)
- [ ] Search a text asset filename or a unique string inside the file — **资产** hit opens the project and the existing preview modal
- [ ] Upload a PNG; searching a string that exists only in the binary bytes returns no asset hit; the filename still matches
- [ ] `GET /api/search?q=` → `{ hits: [] }`; `GET /api/search?q=<term>&limit=2` returns at most 2 hits with `href` / id hints
- [ ] Ctrl+K (or `/` when not typing) focuses the header box; Enter opens the full `#/search` page
- [ ] This is **not** a vector DB, Mem0, marketplace, Desk Remote, or environment builds

## Writable local memory (Milestone H)

No LLM required. Recap is a heuristic template. See [docs/memory.md](./docs/memory.md).

- [ ] Header shows **记忆**. Default runtime is still **本机 Pig**
- [ ] Open `#/memory`, add a pin with unique text + optional tags — JSON appears under `data/memory/`
- [ ] Edit the pin, reload — text persists. Delete removes the file
- [ ] Workstation: **钉住笔记** binds the current `sessionId` (and `projectId` when bound)
- [ ] After a session has user/assistant messages, **写摘要** creates a `kind=recap` note without calling the model
- [ ] Search the pin text (header or `#/search`) — a **记忆** hit opens `#/memory/<id>`
- [ ] `GET /api/memory` lists notes; `POST /api/memory` with `{ "text": "…" }` → 201 pin
- [ ] `POST /api/sessions/<id>/recap` → 201 recap; empty session → 400
- [ ] `GET /api/search?q=<pin text>` includes `{ "type": "memory", "href": "#/memory/…" }`
- [ ] Recent pins inject into the pig system prompt only (covered by `pnpm test`); recaps do not
- [ ] This is **not** embeddings, Mem0, marketplace, Desk Remote, or environment builds
