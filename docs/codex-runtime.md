# Codex runtime (optional MVP)

Pig Agent’s default backend is still the built-in **pig** OpenAI-compatible tool-calling loop. Codex is an **opt-in** alternative that shells out to:

```bash
codex exec --json --skip-git-repo-check -C <realpath-workspace> …
```

Stdin is closed (`stdio: ignore` / `</dev/null>`). Approval is `never` via isolated config — not `danger-full-access`.

## Security defaults

| Control | Default | Notes |
| --- | --- | --- |
| `runtime` | `pig` | Existing sessions/settings keep the pig loop |
| Codex sandbox | `workspace-write` | No danger-full-access in this MVP |
| `sandbox_workspace_write.network_access` | **false** | Explicit Settings opt-in + UI warning |
| `approval_policy` | `never` | Required for non-interactive `exec` |
| Project trust | only `realpath(workspaceRoot)` | Rewritten on workspace change; extra paths stripped |
| `-C` / cwd | same realpath | Asserted before spawn |
| API keys | env only | `DEEPSEEK_API_KEY` or `CODEX_API_KEY` — never committed |
| Provider URL | `https://api.deepseek.com/` | **Not** mapped from pig `llmBaseUrl` (`…/v1` Chat Completions) |
| `CODEX_HOME` | `data/codex-home` (isolated) | Does not reuse `~/.codex` |
| Abort | SIGTERM process group, then SIGKILL after 1.5s | |

## DeepSeek + Codex

Verified with `@openai/codex` **0.154.x**, `wire_api=responses`, model like `deepseek-flash`. Modern Codex rejects `wire_api=chat`. Isolated home gets a generated `models.json` with `base_instructions`.

```bash
# .env.local (gitignored)
DEEPSEEK_API_KEY=sk-...
# optional
CODEX_BIN=codex
CODEX_MODEL=deepseek-flash
PIG_CODEX_HOME=./data/codex-home
# optional provider override — do not paste pig's /v1 chat URL
# CODEX_BASE_URL=https://api.deepseek.com/
```

Install the CLI yourself (`npm i -g @openai/codex@0.154` or the current 0.154.x). Pig does not vendor the binary.

## Multi-turn

Each run builds one prompt from the last N **user/assistant text** messages. Codex is not given a native thread resume, so there is **no Codex-native cross-turn memory**.

## Persistence

Tool calls are stored as pig `session.messages`: an assistant message with `toolCalls` plus a synthetic `role: "tool"` result. Reloading the session rebuilds tool cards the same way as the pig runtime.

## Known gaps (MVP)

- No skills bridge (`list_skills` / `load_skill` are pig-only)
- No `update_plan` / step chips from Codex todo lists
- No fine-grained token streaming (assistant text arrives as completed items)
- No `danger-full-access`
- No mapping of pig Chat Completions URLs into Codex providers
