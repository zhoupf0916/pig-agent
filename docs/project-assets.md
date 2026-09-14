# Project assets + session handoff

Milestone F. Makes project files usable (preview / download / source session) and exposes the existing handoff API in the workstation and project UI.

This is not Desk Remote, environment builds, Firecracker, or a marketplace. Default runtime stays **pig**.

## Preview and download

Assets live under `data/projects/<id>/assets/<assetId>_<filename>`. Upload and session-artifact save (Milestone E) are unchanged.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/projects/:id/assets/:assetId` | JSON preview |
| GET | `/api/projects/:id/assets/:assetId/download` | Raw bytes (`Content-Disposition: attachment`) |
| GET | `/api/projects/:id/assets/:assetId/download?inline=1` | Same bytes, `inline` (for `<img>`) |

Preview payload:

```json
{
  "asset": { "id": "ast_…", "filename": "brief.md", "sourceSessionId": "ses_…", "sourceArtifactPath": "notes/brief.md" },
  "kind": "markdown",
  "content": "# …",
  "binary": false,
  "size": 120
}
```

`kind` is `text` | `markdown` | `json` | `image` | `binary`. JSON is pretty-printed when valid. Images include `contentBase64`. Missing files / unknown ids are 404. Preview limit is 1.5MB (same as upload).

## Handoff

`POST /api/projects/:id/handoffs` already created an inbox item. Milestone F wires the UI and optionally attaches recently saved session artifacts (reuses the Milestone E copy path).

```json
{
  "sessionId": "ses_…",
  "note": "请接手继续。",
  "artifactPaths": ["notes/todo.txt"],
  "attachRecentArtifacts": false
}
```

| Field | Role |
| --- | --- |
| `sessionId` | Required. 404 if the session does not exist. |
| `note` | Optional. Default `请接手继续。` |
| `artifactPaths` | Optional explicit workspace paths to copy into project assets. |
| `attachRecentArtifacts` | If true and `artifactPaths` is empty, attach the newest 8 savable artifacts. |

Attaching files requires `session.projectId === :id` (400 otherwise). Copy is the same overwrite-by-`sourceArtifactPath` rule as [artifacts-to-project.md](./artifacts-to-project.md).

201 body: `{ inboxItem, messages, assets, attached, skipped }`. The inbox item `kind` is `handoff`; `body` may list attached filenames; `assetIds` holds the new/updated asset ids.

## Web

- Project assets list: **预览** modal (Markdown / JSON / text / image), **下载**, **来源会话** when `sourceSessionId` is set.
- Bound session row: **转交**. Workstation header: **转交到收件箱** when a project is pinned. Dialog: note + optional recent artifacts.
- Inbox: handoff items show the note / asset count; **打开会话** jumps to the workstation.

## Out of scope

Version history UI, multi-user ACLs, Desk Remote, Firecracker, marketplace, environment builds.
