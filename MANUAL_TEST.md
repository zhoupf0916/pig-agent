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
