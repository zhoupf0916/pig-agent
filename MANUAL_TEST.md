# Manual test checklist

Use this after `pnpm install && pnpm dev`. UI is http://127.0.0.1:5173.

## Topbar IA

- [ ] Header has **one** search box (no **搜索** tab, and `#/search` has no second input). Ctrl+K / `/` still focuses it; Enter opens `#/search`
- [ ] No **工作台** tab. Click the Pig Agent mark to return to the workstation (`#/` / current session)
- [ ] L1 shows **项目** and **专家** as visible buttons (not inside a menu)
- [ ] **更多** overflow contains only **记忆** and **自动化**
- [ ] **收件箱** sits in the right cluster with **设置** (after the divider)
- [ ] Selected nav is underline + soft ink — **not** a solid-green pill
- [ ] Workstation surface is unchanged: sessions / chat / plan / tool cards / artifacts / workspace

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
- [ ] While Codex env sync / process spawn is in flight the step strip shows 准备 Codex 环境 → 启动 Codex 进程 (not create-run / follow-up / local-stub chips); first tool card or assistant message clears them
- [ ] Tool cards (shell / apply_patch) and an assistant summary appear; **产物** lists the new file
- [ ] Reload the session — tool cards remain (synthetic tool messages persisted)
- [ ] **停止** kills the Codex process group
- [ ] Changing workspace rewrites isolated `data/codex-home/config.toml` `[projects."<realpath>"]` only
- [ ] Deliberate Codex failure (no binary / bad config) — Chinese reason + **重试本轮**; session idle. See Milestone N

## Cloud runtime (optional)

Default runtime stays **本机 Pig**. Cloud is opt-in, like Codex. See [docs/cloud-runtime.md](./docs/cloud-runtime.md).

- [ ] Settings shows three surfaces: **本机 Pig（默认）** / **本机 Codex（可选）** / **云端（可选）**
- [ ] Switch to **云端**：mode defaults to `local-stub`; Base URL / token optional
- [ ] Topbar chip + Settings「当前执行面」read `云端 · local-stub` (or `云端 · remote · <生效 URL>` when remote)
- [ ] `pnpm mock:llm`, Settings Pig Base URL `http://127.0.0.1:8788/v1`, runtime **云端** / local-stub
- [ ] New session: `请写一个 hello-cloud.md，内容为 ok` — while isolate copy is in flight the step strip shows 准备隔离工作区 → 启动本机循环 (not create-run / follow-up chips); then first pig token/tool clears them. Step chips + tool cards + **产物** list the file (stub copies into `data/cloud-runs/<id>/workspace/` then syncs back)
- [ ] `data/cloud-runs/<id>/run.json` has no API keys; isolated copy has no `.env`
- [ ] **停止** while the stub is running returns idle (same control as Pig)
- [ ] Remote mode without a URL refuses to save（中文：未配置控制面 URL）
- [ ] Do **not** put `DEEPSEEK_API_KEY` into a worker env file or commit it
- [ ] `pnpm mock:cloud` listens on `http://127.0.0.1:8080` (no provider key, no cluster)
- [ ] Settings → 云端 → remote → Base URL `http://127.0.0.1:8080`. New session: `请整理工作区` — assistant text mentions `accepted workspace` and lists uploaded files (not `.env`)
- [ ] Same session, second message `再写一个文件` — step strip shows 继续跟进 → 重新连接事件流 (not create-run chips), then reply is `[stub] follow-up: …`. `data/sessions/<id>.json` keeps the same `remoteRunId`
- [ ] Isolated snapshot never includes `.env*`, `id_rsa` / `*.pem`, `node_modules`, or `.git` (see [docs/cloud-runtime.md](./docs/cloud-runtime.md))

## Remote-cloud env.json / environment.json hints (Milestone J1)

Non-secret hints only. Default runtime stays **本机 Pig**. See [docs/cloud-runtime.md](./docs/cloud-runtime.md), `env.json.example`, and `environment.json.example`.

Connection / repo (host):

- [ ] Copy `env.json.example` → `env.json` (repo root). File is gitignored. Do **not** add `PIG_CLOUD_TOKEN` / API keys
- [ ] Settings → 云端 → remote — status shows `env.json 已发现` with baseUrl / repoUrl / ref
- [ ] Click **填入 env.json 提示** — Base URL / 仓库 URL / Ref populate when those fields were empty
- [ ] Settings repo fields win over `env.json`, which wins over `PIG_CLOUD_REPO_*`

Install hints (worker / local prep — Cursor-style `environment.json`):

- [ ] Copy `environment.json.example` → `{workspace}/environment.json` (or repo-root `environment.json`). Values are commands (`pnpm install`), never keys
- [ ] Settings → 云端 → remote — status shows `environment.json 安装提示：install=pnpm install · …`
- [ ] `pnpm mock:cloud`, Settings → remote → Base URL `http://127.0.0.1:8080`. New session: first-turn reply mentions `install pnpm install` (or the command you set)
- [ ] Create-run JSON has `workspace.installHints` and no `DEEPSEEK_API_KEY` / token / `sk-`
- [ ] Isolated snapshot / `data/cloud-runs/<id>/` still skip `.env*` and key files; no worker env file gets a provider key
- [ ] Leave runtime on **本机 Pig** (or switch cloud off) — local golden path unchanged; `environment.json` is just a workspace file
- [ ] Automated: `pnpm test` (parse/strip secrets, ship + control-plane read, default runtime pig)

## Projects + multi-tab sync (Milestone A)

No LLM required for the project surface. Sync live tokens still need a model or `pnpm mock:llm`.

- [ ] Header: brand → workstation, L1 **项目**, **收件箱** in the right cluster. Default runtime is still **本机 Pig**
- [ ] Open `#/projects`, create a project, write an instruction, add a todo, upload a small text asset
- [ ] **在此项目开任务** creates a session bound to the project; chat header shows the project name
- [ ] Invite generates a redeemable token and an unread inbox item; mark read from the inbox menu (full accept/decline loop: J3)
- [ ] `GET /api/projects` lists the project; `GET /api/inbox` shows the invite
- [ ] Two tabs on the same session: tab B does not need a full reload to stay consistent. Or with curl:
  1. `POST /api/sessions` → `id`
  2. Open two terminals: `curl -N http://127.0.0.1:8787/api/sessions/<id>/events`
  3. In a third terminal publish via a running turn, **or** inspect `data/sessions/<id>/events.jsonl` after sending a message
  4. `curl 'http://127.0.0.1:8787/api/sessions/<id>/events?after=1&live=0'` returns seq > 1
- [ ] Re-open the session (or reconnect SSE) after another tab advanced it — transcript matches without refresh-from-scratch
- [ ] This is **not** Desk Remote / Firecracker / experts marketplace

## Multi-tab / multi-device SSE catch-up (Milestone O)

Does **not** change the default runtime (still **本机 Pig**). Reuses the existing `events.jsonl` log. No second write path.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig
- [ ] Two tabs (or `curl -N`) on the same session: disconnect tab B (`Ctrl-C` / close), send from tab A, reconnect B with `?after=<lastSeen>` or `Last-Event-ID` — only new seqs arrive, not seq 1…lastSeen
- [ ] While the gap is replaying, UI shows **正在追平未送达事件…**; when the `sync` `live` frame arrives the bar clears (session idle, or still running if a turn is in flight — not stuck)
- [ ] `curl 'http://127.0.0.1:8787/api/sessions/<id>/events?after=<n>&live=0'` returns only `seq > n`. `data/sessions/<id>/events.jsonl` has no `type: sync` rows
- [ ] Milestone L / M / N still work: remote retry + abort→idle, Pig **重试本轮**, Codex **重试本轮**, Chinese fail banners, no secrets in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Cross-tab top-bar SearchBox (Milestone AL)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/search?q=` refresh of the header `SearchBox` when a query is already present **and** the dropdown is open (complement to Milestone AI's `#/search`). No new write path, no dual-write, no public webhook. Search / navigation / `#/search` semantics unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B top bar already has a query and the dropdown open. Tab A changes session title / project / memory etc. — Tab B’s same-query hits catch up without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/search` when the top bar has no query, or the dropdown is closed
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AK / L·M·N / W·X / Y–AC / AI unchanged. Header search box / Enter / `#/search` navigation stay the existing paths
- [ ] Hit list / JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab workbench pin-dropdown catalogs (Milestone AK)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/projects` + `GET /api/experts` + `GET /api/expert-teams` refresh of the workbench 项目 / 专家 / 小队 pin **option lists**. No new write path, no dual-write, no public webhook. Pin binding still uses the existing paths (Milestone Y). Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on the workbench. Tab A creates / renames / deletes a project or expert / team — Tab B’s pin dropdown catalogs catch up without a full page refresh (focus the tab, become visible, or wait one short poll)
- [ ] Tab B reuses those three existing GETs only. Pin bind / unbind still use the existing session PATCH paths. No new write path, dual-write, or public webhook
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AJ / L·M·N / W·X / Y / AA / AC unchanged
- [ ] Dropdown / JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab Settings skills list (Milestone AJ)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/skills` refresh of the Settings `skills/` list. No new write path, no dual-write, no public webhook. `list_skills` / `load_skill` semantics unchanged. Does **not** expand the Codex skills bridge. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already has Settings open. Tab A adds / edits / deletes `skills/*.md` — Tab B’s skills list catches up without a full page refresh (focus the tab, become visible, or wait one short poll)
- [ ] Tab B reuses the existing `GET /api/skills` only. No new write path, dual-write, or public webhook
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AI / L·M·N / W·X / Y–AC unchanged. Codex MVP still does not bridge Pig skills
- [ ] Settings skills list / JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab search results (Milestone AI)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/search?q=` refresh of `#/search` when a query is already present. No new write path, no dual-write, no public webhook. Search / navigation semantics unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/search` with a query. Tab A changes session title / project / memory etc. — Tab B’s same-query hits catch up without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/search` when `#/search` has no query
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AH / L·M·N / W·X / Y–AC unchanged. Header search box / Enter / `#/search` navigation stay the existing paths
- [ ] Hit list / JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab open Settings form (Milestone AH)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/settings` refresh of an already-open Settings modal's non-secret fields (complement to Milestone R's chip). No new write path, no settings dual-write, no public webhook. Save still uses the existing PUT. Not a credentials vault / connector / multi-agent change.

- [ ] Two workstation tabs on the same host. Tab B already has Settings open. Tab A saves non-secret fields (llm / workspace / cloud / codex, etc.) — Tab B's form catches up without a full page refresh (focus the tab or wait one short poll)
- [ ] Secrets the user is typing on Tab B (`API Key` / 控制面 Token) are **not** overwritten. Chip still follows runtime saves as in Milestone R
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AG / L·M·N / W·X / Y–AC / R unchanged
- [ ] Settings form / JSON / logs never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab inbox menu (Milestone AF)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/inbox` refresh of the header unread badge + list. No new write path, no dual-write of inbox / sessions / events, no public webhook. Accept / decline / read stay the existing POSTs. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host. Tab A creates an invite / transfer, or marks read / **接受** / **忽略** — Tab B badge + list update without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B reuses the existing `GET /api/inbox` only. Accept / reject / read still use the existing POSTs. No new write path, dual-write, or public webhook
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AE / L·M·N / W·X / Y–AC / AG unchanged
- [ ] Menu / badge / inbox JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` / invite token plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab experts directory (Milestone AC)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/experts` (+ `GET /api/expert-teams`) refresh of `#/experts`; already-open detail also `GET /api/experts/:id`. No new write path, no dual-write of sessions / events, no public webhook. Session pin / sequential expert-team run semantics unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/experts`. Tab A creates / edits / deletes an expert or changes the expert-team list — Tab B list (and the already-open detail, if that expert is open) update without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/experts/:id` when that expert's detail is not open. List still catches up from `GET /api/experts` (+ teams from `GET /api/expert-teams`)
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, V theme, Y pins, Z automations last-run, AA projects, AB memory, and L/M/N / W·X cloud progress unchanged. Session pin / sequential expert-team run stay the existing paths
- [ ] Panel / banner / expert JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab memory directory (Milestone AB)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/memory` refresh of `#/memory`; already-open detail also `GET /api/memory/:id`. No new write path, no dual-write of memory / sessions / events, no public webhook. Pin / write-summary / search semantics unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/memory`. Tab A (or workbench **钉住笔记** / **写摘要**) pins / edits / deletes a note — Tab B list (and the already-open detail, if that note is open) update without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/memory/:id` when that note's detail is not open. List still catches up from `GET /api/memory`
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, V theme, Y pins, Z automations last-run, AA projects, and L/M/N / W·X cloud progress unchanged. Pin / write-summary / search stay the existing paths
- [ ] Panel / banner / memory JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab projects board / assets / members (Milestone AA)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/projects` refresh of `#/projects`; open detail also `GET /api/projects/:id`. No new write path, no dual-write of projects / sessions / events, no public webhook. Invite / transfer semantics unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/projects` with a project open. Tab A changes a todo status / uploads an asset / invite·accept changes members — Tab B board · assets · members update without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/projects/:id` when that project's detail is not open. List-side name / `updatedAt` may still catch up from `GET /api/projects`
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, V theme, Y pins, Z automations last-run, and L/M/N / W·X cloud progress unchanged. Invite / redeem / transfer stay the existing paths
- [ ] Panel / banner / project JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab automations directory (Milestone AG)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/automations` refresh of the full `#/automations` list snapshot (row add/remove, enable / cron / name, plus last-run). Selected item may also `GET /api/automations/:id`. No new write path, no dual-write of automations / sessions / events, no public webhook. 「立即运行」 / 409 in-flight unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/automations`. Tab A creates / toggles enable / changes cron / renames / deletes a row — Tab B list (and the already-open detail, if any) update without a full page refresh (focus the tab or wait one short poll)
- [ ] List-visible row / enable / cron / name updates even when Tab B does **not** have that item’s detail open. Last-run fields still catch up as in Milestone Z
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AF / L·M·N / W·X / Y–AC / Z unchanged. 「立即运行」 still 409 while in flight
- [ ] List / detail / banner / automation JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab automations list last-run (Milestone Z)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/automations` refresh of 上次运行 / `lastSessionId` / `lastError` on `#/automations`. Selected item may also `GET /api/automations/:id`. No new write path, no dual-write of automations / sessions / events, no public webhook. 「立即运行」 / 409 in-flight unchanged. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already on `#/automations`. Tab A (or local cron) finishes a run — Tab B that row’s **上次运行** / session entry / error update without a full page refresh (focus the tab or wait one short poll)
- [ ] List-visible last-run fields update even when Tab B does **not** have that item’s detail open
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, V theme, Y pins, and L/M/N / W·X cloud progress unchanged. 「立即运行」 still 409 while in flight
- [ ] List / detail / banner / automation JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab open session deleted elsewhere (Milestone AN)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/sessions` detects that the already-open session id is gone (complement to Milestone AM title / status). Clear the open state or switch to the next sidebar session. No new write path, no dual-write of sessions / `events.jsonl`, no public webhook, no transcript fetch of the deleted row. Delete still uses existing `DELETE`. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already has a session open. Tab A **deletes** that session — Tab B closes out the open state (clear or switch away) without a full page refresh (focus the tab or wait one short poll). Do not stay on the deleted session
- [ ] Tab B does **not** GET `/api/sessions/:id` for the deleted row or reload other sessions' transcripts
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AM / L·M·N / W·X / Q / Y / AK unchanged
- [ ] Session list / open / JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab open session title / status (Milestone AM)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/sessions` refresh of the already-open session's `title` / `status` (complement to Milestone Y pins). No new write path, no dual-write of sessions / `events.jsonl`, no public webhook, no transcript reload. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host, Tab B already has a session open. Tab A **renames** or flips **运行中** ↔ idle — Tab B's open session title / status catch up without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** GET `/api/sessions/:id` or reload transcript / steps for this catch-up. Pins still follow Milestone Y
- [ ] Header chip still defaults to **本机 Pig**. Milestone O–AL / L·M·N / W·X / Y / AK unchanged
- [ ] Title / status / session JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab session pins (Milestone Y)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/sessions` refresh of the open session's 项目 / 专家 / 小队 pins. No new write path, no dual-write of sessions / `events.jsonl`. Not a credentials vault / connector / multi-agent / public webhook / sandbox change.

- [ ] Two workstation tabs on the same host, same `#/sessions/<id>`. Tab A changes **项目** / **专家** / **小队** — Tab B dropdowns and hints match without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab A unbinds to **未绑定** — Tab B clears the same pin(s) the same way
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, V theme, and L/M/N / W·X cloud progress unchanged
- [ ] Pin row / banner / session JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, public webhook, or sandbox change

## Cross-tab theme (Milestone V)

Client-only (`localStorage` key `pig-agent.theme`). Same-host Tab B follows Tab A's header 深色 / 浅色 via the `storage` event, or on focus / visibility. Does **not** change Settings runtime (still **本机 Pig**). No new key, no server persist, no dual-write of settings / sessions / events. Not a credentials vault / connector / multi-agent / sandbox change.

- [ ] Two workstation tabs on the same host. Tab A header **深色** — Tab B switches to dark without a full page refresh (switch to Tab B or wait for the `storage` event)
- [ ] Tab A **浅色** — Tab B returns to light the same way. Reload still keeps the last choice (Milestone J2)
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, U file preview, and L/M/N retry / abort paths unchanged
- [ ] Theme toggle / banner / settings never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext. Only `pig-agent.theme` is used
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, multi-agent parallelism, or sandbox change

## Cross-tab workspace file preview (Milestone U)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/workspace/file` refresh of the already-open preview path. No second write path, no dual-write of workspace / sessions / events. Orthogonal to Milestone T tree listing. Not a credentials vault / connector / multi-agent change. Sandbox boundary unchanged.

- [ ] Two workstation tabs on the same host. Tab B has a workspace path open in **预览**. Tab A runs a turn that modifies that same path — Tab B preview text / size updates without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** need to be on the same session. Closing the preview (or never opening one) means no file GET. Tree listing still follows Milestone T independently
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, T tree refresh, and L/M/N retry / abort paths unchanged
- [ ] Preview / banner / settings never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Cross-tab workspace browser tree (Milestone T)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/workspace/tree` refresh. No second write path, no dual-write of workspace / sessions / events. Not a credentials vault / connector / multi-agent change. Sandbox boundary unchanged.

- [ ] Two workstation tabs on the same host. Tab A runs a turn that creates or modifies a sandbox file — Tab B **工作区** tree shows the new / updated path without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab B does **not** need to be on the same session; switching to the 工作区 tab (or focusing the window) is enough. Tree nodes are names only — no file contents / API keys
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, S draft sync, and L/M/N retry / abort paths unchanged
- [ ] Tree / banner / settings never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Cross-tab composer drafts (Milestone S)

Client-only (`localStorage` key `pig-agent.composer-drafts`). Same-host Tab B follows Tab A's unsent composer via the `storage` event, or on focus / visibility. Does **not** change Settings runtime (still **本机 Pig**). No server persist, no dual-write of settings / sessions / events. Not a credentials vault / connector / multi-agent change.

- [ ] Two workstation tabs on the same host, same `#/sessions/<id>`. Type in Tab A — Tab B composer updates without a full page refresh (switch to Tab B or wait for the `storage` event)
- [ ] Tab A **发送** or empty the composer — Tab B's draft for that session clears. A different session still keeps its own draft
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P persist, Q sidebar running→idle, R chip sync, and L/M/N retry / abort paths unchanged
- [ ] Settings / API key fields never appear in `localStorage` `pig-agent.composer-drafts`. Banner / settings still redact secrets
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Cross-tab execution-surface chip (Milestone R)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/settings` refresh. No second write path, no settings dual-write, no events.jsonl change. Not a credentials vault / connector / multi-agent change.

- [ ] Two workstation tabs on the same host. Tab A Settings: switch runtime (Codex or 云端) and **保存** — Tab B top-bar chip matches (本机 Codex / 云端 · …) without a full page refresh (focus the tab or wait one short poll)
- [ ] Tab A switches back to **本机 Pig（默认）** and saves — both tabs show **本机 Pig**; chip copy is the existing execution-surface label (not a third status string)
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P drafts, Q sidebar running→idle, and L/M/N retry / abort paths unchanged
- [ ] Chip / banner / settings never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Cross-tab session sidebar status (Milestone Q)

Does **not** change the default runtime (still **本机 Pig**). Read-only `GET /api/sessions` refresh. No second write path, no events.jsonl change. Not a credentials vault / connector / multi-agent change.

- [ ] Two workstation tabs on the same host. Tab A starts a turn — Tab B sidebar shows that session as **运行中** (pulse) without a full page refresh
- [ ] When the turn ends (success / fail / **停止**), Tab B sidebar returns to idle (or **出错**); title / time may update
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar, P drafts, and L/M/N retry / abort paths unchanged
- [ ] Banner / settings / list JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Composer drafts per session (Milestone P)

Client-only (`localStorage` key `pig-agent.composer-drafts`). Does **not** change Settings runtime (still **本机 Pig**). Does **not** write API keys or Settings into draft storage.

- [ ] Same session: type unsent text in the workstation composer, refresh or reopen `#/sessions/<id>` — the draft is still there
- [ ] Switch to another session, type a different draft, switch back — each session keeps its own text; neither overwrites the other
- [ ] **发送** (or empty the composer) clears only the current session's draft; the other session still restores
- [ ] Header chip still defaults to **本机 Pig**. Milestone O catch-up bar and L/M/N retry / abort paths unchanged
- [ ] Settings / API key fields never appear in `localStorage` `pig-agent.composer-drafts`. Banner / settings still redact secrets
- [ ] Automated: `pnpm test` + `pnpm typecheck`
- [ ] This is **not** a credentials vault, connector, or multi-agent parallelism change

## Local experts / playbooks (Milestone C)

No LLM required for the directory. Prompt injection is covered by `pnpm test`.

- [ ] Header L1 shows **专家**. Default runtime is still **本机 Pig**
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

- [ ] Header: **更多** → **自动化**. Default runtime is still **本机 Pig**
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

- [ ] Header has a single search box (no **搜索** tab). Default runtime is still **本机 Pig**
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

- [ ] Header: **更多** → **记忆**. Default runtime is still **本机 Pig**
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

## Expert-team sequential runner (Milestone I)

Same-session chain (not handoff-per-step). Default runtime stays **本机 Pig**. Sequential coverage is in `pnpm test` (scripted LLM, no live DeepSeek). See [docs/experts.md](./docs/experts.md).

- [ ] Header still brand → workstation and L1 **专家**. Default runtime is **本机 Pig**
- [ ] Bind **编码流水线** on a session — pin row shows 小队流水线 chips (侦察 → 规划 → 实现 → 评审) and **顺序执行小队**
- [ ] Pin a single expert as well — hint reads 已钉选单个专家，小队仅作元数据; the sequential button hides
- [ ] `pnpm mock:llm`, Settings Pig Base URL `http://127.0.0.1:8788/v1`. New session, bind 编码流水线, click **顺序执行小队** with a short goal — `[team] 1/4 · 侦察 Scout 开始` markers appear, chips advance, session stays one transcript
- [ ] **停止** mid-pipeline returns idle; remaining chips become cancelled; **继续小队** resumes
- [ ] `POST /api/sessions/<id>/team-run` with `{ "action": "start", "content": "…" }` is SSE; `{ "action": "stop" }` cancels
- [ ] A normal send on a chain-team session (no `expertId`) also starts the sequential pipeline
- [ ] Project instruction + 钉住笔记 still apply to each member (same precedence: expert → project → pins)
- [ ] Parallel teams stay one concatenated turn (no pipeline auto-run)
- [ ] This is **not** marketplace, parallel subagents across machines, Desk Remote, embeddings, or environment builds

## Theme persistence + light readability (Milestone J2)

Client-only (`localStorage` key `pig-agent.theme`). Does **not** change Settings runtime (still **本机 Pig**).

- [ ] First visit with empty storage is **light** (Codex-style white/gray panels, green accent)
- [ ] Header **深色** switches to dark; a full page reload keeps dark
- [ ] Header **浅色** switches back to light; reload keeps light
- [ ] Light mode: step strip chips, tool cards, and artifacts / workspace rows have readable contrast (not washed-out gray-on-gray)
- [ ] Settings still defaults to runtime **Pig**; saving settings does not reset the theme
- [ ] This is **not** a runtime change, Desk Remote, marketplace, or environment builds

## Project invites / local multi-user (Milestone J3)

No LLM required. Same host, named members — not SSO. See [docs/project-invites.md](./docs/project-invites.md). Handoff (Milestone F) must keep working.

- [ ] Header **项目** / **收件箱** unchanged. Default runtime is still **本机 Pig**. No Settings redesign
- [ ] Open `#/projects`, create a project. Members list shows **本机用户 · 所有者** (不可移除)
- [ ] Invite with display name + optional note → pending row appears; token is shown and copyable; unread inbox item has project name + inviter / note
- [ ] Inbox **接受** adds the member, clears pending, and can open the project. Accept the same invite again — still one member
- [ ] Invite another name → inbox **忽略** marks it terminal and does **not** open that project; that name is not in members
- [ ] Invite again, paste the token on the project page **兑换** — member is added
- [ ] Pending row **撤销** removes the invite without adding a member
- [ ] Click an invite row (or **标为已读**) marks read; Esc / click outside closes the inbox
- [ ] Bound session **转交** still creates a `kind=handoff` inbox item; **打开会话** returns to the workstation
- [ ] `POST /api/projects/<id>/members` `{ displayName, note }` → 201 + pending invite + inbox `kind=invite`
- [ ] `POST /api/inbox/<id>/accept` then again → member once. `POST /api/projects/<id>/invites/redeem` with the token also works
- [ ] Paste a bogus / already-declined token on **兑换** — readable error, members unchanged
- [ ] `DELETE /api/projects/<id>/members/<ownerId>` → 400
- [ ] This is **not** SSO, email, Desk Remote, Firecracker, marketplace, or a cloud ACL rewrite

## Execution-surface observability (Milestone K)

Does **not** change the default runtime (still **本机 Pig**). No new backends / SSO / invites.

- [ ] Header chip is always visible: default **本机 Pig** (+ model / host). Settings「当前执行面」matches
- [ ] Settings → **本机 Codex** — chip / 当前执行面 become **本机 Codex · &lt;model&gt;** (外网已开 when toggled). Cancel without save — chip stays Pig
- [ ] Settings → **云端** / local-stub — chip reads **云端 · local-stub**. Switch mode to **remote** + URL `http://127.0.0.1:8080` — chip / 当前执行面 read **云端 · remote · http://127.0.0.1:8080**
- [ ] Remote without a URL refuses to save with a Chinese reason（未配置控制面 URL）, not a silent/black-box English string
- [ ] Deliberate remote send failures show Chinese `session.lastError` in the yellow banner: missing URL / 工作区快照失败 / 控制面请求超时
- [ ] Leave runtime on **本机 Pig** — local golden path unchanged
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Remote create-run progress (Milestone W)

Does **not** change the default runtime (still **本机 Pig**). Reuses the existing `steps` SSE channel. No public webhooks. Failures stay on Milestone L retry / abort → idle.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig — local golden path unchanged
- [ ] `pnpm mock:cloud`, Settings → 云端 / remote → `http://127.0.0.1:8080`. New session, send a turn — while create-run is in flight the step strip (and the 正在思考 line) shows Chinese progress: 准备沙箱快照 → 创建远程运行 → 连接事件流
- [ ] After the plane streams, bootstrap chips clear and the UI is the live turn (tokens / tool cards / idle)
- [ ] Deliberate create-run failure (stop the mock / 500) — yellow banner + existing **重试 · 重新创建运行**; session is `error` / idle after abort, never stuck `running`
- [ ] **停止** during hung create-run → idle; next send works (no 409 zombie)
- [ ] Progress copy / banner / session JSON never show `sk-…` / `PIG_CLOUD_TOKEN` / Bearer tokens
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Local-turn recoverability (Milestone M)

Does **not** change the default runtime (still **本机 Pig**). No new backends / SSO. Milestone N covers the Codex path.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig
- [ ] Deliberate Pig failure (bad API key / closed LLM port / tool loop that cannot recover) — yellow banner shows a **Chinese** reason (密钥无效 / 无法连接 LLM 网关 / 工具调用失败). Session is **idle**, not stuck `running`
- [ ] Click **重试本轮** — the same user goal runs again; the transcript does **not** get a second copy of that user message. Or the button reads **无法重试** when there is no user goal
- [ ] Banner / session JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` in plaintext
- [ ] Remote L still works: 云端 / remote **重试 · 继续跟进** / **重试 · 重新创建运行** / abort → idle. Do not regress #24
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Codex-turn recoverability (Milestone N)

Does **not** change the default runtime (still **本机 Pig**). No new backends / SSO / Milestone O.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig unless you are testing Codex
- [ ] Settings → **本机 Codex**, deliberate failure (missing binary path / bad config / no CLI) — yellow banner shows a **Chinese** reason (未找到 Codex 二进制 / 进程启动失败 / 本轮执行失败). Session is **idle**, not stuck `running`
- [ ] Click **重试本轮** — the same user goal runs again (or the banner clearly says **无法重试** / still unavailable). The transcript does **not** get a second copy of that user message
- [ ] Switch back to **本机 Pig** — Milestone M 重试本轮 / idle still works. Remote L **重试 · 继续跟进** / **重试 · 重新创建运行** / abort → idle still works
- [ ] Banner / session JSON never show `sk-…` / `Bearer` / `DEEPSEEK_API_KEY` / `CODEX_API_KEY` values in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Remote recoverability (Milestone L)

Does **not** change the default runtime (still **本机 Pig**). No new backends / SSO. Milestone M covers the local pig path; Milestone N covers Codex.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig — local golden path unchanged
- [ ] Settings → 云端 / remote without a URL — Chinese reason（未配置控制面 URL）, not a hang; **重试** stays available / clearly unavailable until a URL is set
- [ ] `pnpm mock:cloud` then remote URL `http://127.0.0.1:8080`. Send a turn, then stop the mock mid-stream or point at a closed port — yellow banner shows 控制面请求超时 / 连接已中断 (Chinese), no deadlock
- [ ] Click **重试 · 继续跟进** or **重试 · 重新创建运行** — another round runs, or the same Chinese unavailable reason if the plane is still down
- [ ] Expire / delete the remote run (or `404` the events route) — banner reads 远程运行已过期; retry allocates a new create-run
- [ ] **停止** while remote SSE is open → session idle; send again works (no 409 zombie)
- [ ] Banner / session JSON never show `sk-…` / `PIG_CLOUD_TOKEN` / Bearer tokens in plaintext
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Codex startup progress (Milestone AE)

Does **not** change the default runtime (still **本机 Pig**). Reuses the existing `steps` SSE channel and the Milestone W `CreateRunProgress` machine (fourth catalog `codex:`, not a new SM). Mutually exclusive with W `create-run:` / X `follow-up:` / AD `local-stub:` copy. No public webhooks. Failures stay on Milestone N Chinese banner / **重试本轮**; abort → idle.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig — local golden path unchanged
- [ ] Settings → **本机 Codex**. New session, send a turn — while env sync / process spawn is in flight the step strip (and the 正在思考 line) shows Chinese progress: 准备 Codex 环境 → 启动 Codex 进程 — **not** create-run / follow-up / local-stub chips
- [ ] After the first tool card or assistant message, bootstrap chips clear and the UI is the live turn (tool cards / assistant / idle)
- [ ] Deliberate Codex failure (no binary / bad start) — yellow banner + existing **重试本轮**; session is `idle` after abort, never stuck `running`
- [ ] **停止** during hung Codex spawn → idle; next send works (no 409 zombie)
- [ ] Progress copy / banner / session JSON never show `sk-…` / `CODEX_API_KEY` / Bearer tokens
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Local-stub materialize progress (Milestone AD)

Does **not** change the default runtime (still **本机 Pig**). Reuses the existing `steps` SSE channel and the Milestone W `CreateRunProgress` machine (third catalog `local-stub:`, not a fourth SM). Mutually exclusive with W `create-run:` and X `follow-up:` copy. No public webhooks. Failures stay on existing Chinese banner / retry; abort → idle.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig — local golden path unchanged
- [ ] `pnpm mock:llm`, Settings → 云端 / local-stub. New session, send a turn — while isolate materialize is in flight the step strip (and the 正在思考 line) shows Chinese progress: 准备隔离工作区 → 启动本机循环 — **not** create-run / follow-up chips
- [ ] After the first pig token / tool event, bootstrap chips clear and the UI is the live turn (tokens / tool cards / idle)
- [ ] Deliberate Pig failure (bad key / closed LLM port) — yellow banner + existing **重试本轮**; session is `idle` after abort, never stuck `running`
- [ ] **停止** during hung local-stub turn → idle; next send works (no 409 zombie)
- [ ] Progress copy / banner / session JSON never show `sk-…` / `PIG_CLOUD_TOKEN` / Bearer tokens
- [ ] Automated: `pnpm test` + `pnpm typecheck`

## Remote follow-up / reconnect progress (Milestone X)

Does **not** change the default runtime (still **本机 Pig**). Reuses the existing `steps` SSE channel and the Milestone W `CreateRunProgress` machine (second catalog, not a third SM). No public webhooks. Failures stay on Milestone L retry / abort → idle. Does not replace Milestone W create-run chips.

- [ ] Header chip still defaults to **本机 Pig**. Settings runtime left on Pig — local golden path unchanged
- [ ] After a live `remoteRunId` (same session, second message or **重试 · 继续跟进**): step strip (and the thinking line) shows Chinese progress: 继续跟进 → 重新连接事件流 — **not** 准备沙箱快照 / 创建远程运行
- [ ] After the plane streams, follow-up chips clear and the UI is the live turn (tokens / tool cards / idle)
- [ ] Deliberate follow-up timeout / disconnect — yellow banner + existing **重试 · 继续跟进**; session is `error` / idle after abort, never stuck `running`
- [ ] Expired follow-up (404) falls back to Milestone W create-run chips (准备沙箱快照 → 创建远程运行 → 连接事件流); catalogs do not mix
- [ ] **停止** during hung follow-up → idle; next send works (no 409 zombie)
- [ ] Progress copy / banner / session JSON never show `sk-…` / `PIG_CLOUD_TOKEN` / Bearer tokens
- [ ] Automated: `pnpm test` + `pnpm typecheck`
