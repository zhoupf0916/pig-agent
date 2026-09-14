# Writable local memory

Milestone H. Users and the agent workstation can **pin facts** and optionally write a **short turn recap**. Notes live as JSON on this machine and are indexed by the existing `GET /api/search` (type `memory`). No embeddings, no Mem0, no vector DB.

Default runtime stays **pig**. This is not Desk Remote, marketplace, or environment builds.

## Storage

| Path | Role |
| --- | --- |
| `data/memory/<id>.json` | One note (`pin` or `recap`) |

```json
{
  "id": "mem_…",
  "kind": "pin",
  "text": "默认用 DeepSeek",
  "tags": ["llm"],
  "sessionId": "ses_…",
  "projectId": "prj_…",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`tags`, `sessionId`, and `projectId` are optional. Text is capped at 8 000 characters; at most 12 tags.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/api/memory` | List accepts `kind`, `sessionId`, `projectId`, `limit` |
| GET / PATCH / DELETE | `/api/memory/:id` | |
| POST | `/api/sessions/:id/recap` | Writes a new `recap` from recent messages |

`POST /api/memory` defaults `kind` to `pin`. Recaps are usually created via the session endpoint (a new note each time, not an in-place upsert).

### Recap

`POST /api/sessions/:id/recap` is a **heuristic / template** over the last 8 user / assistant messages (skips tool / harness lines). It does **not** call the LLM, so `pnpm test` stays offline. Empty transcripts return 400.

## Search

The Milestone G index now also scans memory `text` and `tags`. Hits use `type: "memory"` and `href: "#/memory/<id>"`. See [search.md](./search.md).

## Pig system prompt (optional, small)

When the pig loop builds a system prompt, it injects the **top 5 recent pins** that are in scope for the current session:

- Global pins (no `sessionId` / `projectId`)
- Pins whose `sessionId` matches this session
- Project-scoped pins (no `sessionId`) when the session is bound to that project

Pins scoped to **other** sessions are not injected. Each pin is clipped to 200 characters. **Recaps are not injected** (the transcript already has that history).

Codex and cloud runtimes do **not** receive this block. Expert then project still precede the pin list.

Treat pins as user-curated facts, not a license to leave the workspace.

## Web

- `#/memory` directory: list / add pin / edit / delete. Filter 全部 / 钉住 / 摘要.
- `#/memory/<id>` selects a note. Search hits navigate here.
- Workstation header: **钉住笔记** (dialog, binds `sessionId` / `projectId`) and **写摘要** (heuristic recap).

## Out of scope

Embeddings / Mem0, marketplace, Desk Remote, environment builds, automatic recap after every turn. Sequential expert-team runs (Milestone I) reuse the same pin injection on each member turn.
