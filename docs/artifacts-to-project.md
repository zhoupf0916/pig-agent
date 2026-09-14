# Session artifacts → project assets

Milestone E. Neo-style **one-click (and optional auto) copy** of session deliverables into the bound project's asset store so collaboration keeps the files, not just the chat.

This is not Desk Remote, environment builds, or a marketplace.

## Default

**Idempotent overwrite by workspace path.** Saving `notes/todo.txt` twice (or from a later automation run) updates the same project asset (`id` stays). Distinct artifact paths that share a basename get a versioned filename (`todo-2.txt`). Deleted artifacts are skipped — the file is gone.

Copy is bytes from the current workspace file (sandboxed path), plus metadata: `sourceSessionId`, `sourceArtifactPath`, `updatedAt`.

## API

Requires `session.projectId`. 400 if the session is unbound.

| Method | Path |
| --- | --- |
| POST | `/api/sessions/:id/artifacts/:name/save-to-project` |
| POST | `/api/sessions/:id/artifacts/save-to-project` (body `{ "path": "notes/todo.txt" }`) |
| POST | `/api/sessions/:id/artifacts/save-all-to-project` (optional `{ "paths": [...] }`) |

`:name` is the artifact path (URL-encoded if it contains `/`) or a **unique** basename. Ambiguous basenames return 409.

Single save returns `{ projectId, artifactPath, asset, overwritten }`. Save-all returns `{ projectId, saved, skipped }`.

Limit: 1.5MB per file (same as project upload).

## Automation (opt-in)

Field `saveArtifactsToProject` (default **false**). After a successful run, if the new session has `projectId` and artifacts, new files are copied with the same overwrite rule.

A failed or aborted run does not copy. A copy failure is recorded on `lastError` (`run ok; artifact save failed: …`) and does not rewind the session.

## Web

Bound sessions show **保存到项目** on the artifacts panel (and per-row **保存**). Toast links to `#/projects/<id>` asset list. Automations have a checkbox when a project is pinned.

## Out of scope

Version history UI, Desk Remote, Firecracker, marketplace. Preview / download / handoff UI is Milestone F — see [project-assets.md](./project-assets.md).
