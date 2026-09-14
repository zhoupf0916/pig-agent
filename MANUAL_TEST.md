# Manual test checklist

Use this after `pnpm install && pnpm dev`. UI is http://127.0.0.1:5173.

## Smoke (no LLM required)

- [ ] Page loads: left sessions, center chat, right artifacts/workspace
- [ ] **Settings** shows defaults (`http://127.0.0.1:11434/v1`, model `llama3.2`, workspace `sample-workspace`)
- [ ] Change a field, save, reload — values persist
- [ ] Right panel **工作区** lists `notes/`, `drafts/`, `scattered-log.txt`, `README.md`
- [ ] Click `notes/meeting-2026-03-14.md` — Markdown preview renders
- [ ] Click `notes/todo.txt` — plain text preview
- [ ] **新任务** creates a session; delete icon removes it
- [ ] `GET /api/health` → `{ ok: true }`
- [ ] `POST /api/workspace/resolve` with `{ "path": "../package.json" }` → 400 / escape error

## Agent path (Ollama or any OpenAI-compatible endpoint)

- [ ] Ollama running **or** `pnpm mock:llm` and Settings Base URL `http://127.0.0.1:8788/v1`
- [ ] New session, send: `整理工作区并写一份摘要 README`
- [ ] Tokens stream (real model) or a final assistant message appears (mock)
- [ ] Step chips and tool cards show `list_dir` / `read_file` / `write_file` (or similar)
- [ ] **产物** lists a created or modified file (usually `README.md`)
- [ ] Opening that artifact shows the new contents
- [ ] Workspace tree refreshes after writes
- [ ] **停止** while running returns the session to idle (real model, longer run)

## Sandbox

- [ ] Ask the agent to `read /etc/passwd` or `write ../outside.md` — tool result is a sandbox error, no file outside the workspace
- [ ] Automated coverage: `pnpm test` (path traversal, symlink hop, shell reject, mock agent write)

## Skills

- [ ] Settings lists `organize-workspace`, `write-summary`, `daily-notes`
- [ ] A matching ask (e.g. daily note) causes `list_skills` / `load_skill` on a capable model
