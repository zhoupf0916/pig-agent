# Local search / memory (v1)

Milestone G. Neo-inspired **read-only find**: one substring / token index over this machine’s session transcripts and project records. No embeddings, no Mem0, no vector DB.

Default runtime stays **pig**. This is not Desk Remote, marketplace, or environment builds.

## What is scanned

| Source | Fields |
| --- | --- |
| Sessions (`data/sessions/*.json`) | Title + the last 40 user / assistant messages |
| Projects (`data/projects/<id>/project.json`) | Name, instruction, todos, activity / comment / handoff bodies |
| Project assets | Filename always; text / Markdown / JSON **content** when the file is small and not binary |
| Memory (`data/memory/*.json`) | Pin / recap `text` and `tags` (Milestone H) |

Skipped: tool / system messages, images, other binary assets, files over **256KB**, missing asset bytes. Experts and automations are not in this index. Recaps are searchable but are **not** injected into the pig prompt (pins are; see [memory.md](./memory.md)).

## Matching

1. Trim and collapse whitespace.
2. A field matches if it contains the full query (case-insensitive) **or** every token (split on whitespace / light punctuation).
3. Hits are ranked by field weight (title > body) plus a small recency boost, then cut to `limit`.

Chinese queries without spaces are one token and use substring match (`调研报告` finds `请写一份调研报告`).

## API

`GET /api/search?q=&limit=`

| Query | Default | Notes |
| --- | --- | --- |
| `q` | (required to search) | Blank / missing → `{ hits: [] }` |
| `limit` | 20 | Clamped to 1–50 |

```json
{
  "q": "调研报告",
  "limit": 20,
  "hits": [
    {
      "type": "session",
      "id": "ses_…",
      "title": "整理笔记",
      "snippet": "…请写一份调研报告草稿…",
      "href": "#/sessions/ses_…",
      "sessionId": "ses_…"
    }
  ]
}
```

`type` is one of `session` | `project` | `todo` | `asset` | `project_message` | `memory`.

Route hints (in addition to `href`):

| type | href | extra ids |
| --- | --- | --- |
| session | `#/sessions/<id>` | `sessionId` |
| project | `#/projects/<id>` | `projectId` |
| todo | `#/projects/<id>?todo=<todoId>` | `projectId`, `todoId` |
| asset | `#/projects/<id>?asset=<assetId>` | `projectId`, `assetId` |
| project_message | `#/projects/<id>` | `projectId`, `messageId` |
| memory | `#/memory/<id>` | optional `sessionId`, `projectId` |

## Web

- Single header search box (no separate **搜索** tab, no second box on `#/search`) with a live dropdown. **Enter** or **查看全部结果** opens `#/search?q=`.
- `#/search` is the full result page, grouped by type. The header box stays the only query field.
- Clicking a hit opens the session workstation, the project, a highlighted todo, the existing asset preview modal, or `#/memory/<id>`.
- Shortcuts: `Ctrl+K` / `⌘K`, or `/` when not typing in another field.

## Out of scope

Vector / embedding index, Mem0, marketplace, Desk Remote, environment builds, indexing experts or automations.
