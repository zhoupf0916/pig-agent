# Local automations

Milestone D. Neo-inspired **scheduled / manual runs**, not public webhooks and not remote workers.

An automation is a JSON record on this machine. **Run now** or a simple in-process cron creates a new session, pins `expertId` / `expertTeamId` / `projectId`, and starts the existing pig (default) runner with a stored prompt.

## Storage

| Path | Role |
| --- | --- |
| `data/automations/<id>.json` | One automation |

Fields: `id`, `name`, `enabled`, `prompt`, `schedule` (5-field cron, `@hourly`, `@daily`, or `null` for manual-only), optional `expertId` / `expertTeamId` / `projectId`, `runtime` (default `pig`), `saveArtifactsToProject` (default **false**; see [artifacts-to-project.md](./artifacts-to-project.md)), `lastRunAt`, `lastSessionId`, `lastError`, plus `createdAt` / `updatedAt`.

Keys stay in `.env.local` / Settings. They are never written into automation JSON.

## Schedule

- Empty / `null` → only **立即运行**.
- `@hourly` → `0 * * * *` (local time).
- `@daily` → `0 0 * * *` (local midnight).
- Any 5-field cron: `minute hour day-of-month month day-of-week`.

Due rule: the latest matching minute **at or before now** is strictly after `lastRunAt` (or `createdAt` if never run). A brand-new `@daily` created in the afternoon does **not** fire until the next midnight.

The process polls about every **30 seconds**. The same automation will not start a second run while one is in flight (HTTP `409`).

`createApp()` used by tests does **not** start the timer. `server/src/index.ts` does (`pnpm dev` / `pnpm start`).

## Run path

1. Create a session (`POST /api/sessions` semantics).
2. Bind project / expert / team on that session.
3. Enqueue the existing `runSessionTurn` with `runtime` from the record (default **pig**, not the Settings UI).
4. Persist events so the workstation can open the session and subscribe as usual.
5. If `saveArtifactsToProject` is true and the run succeeded with artifacts, copy them into the bound project (opt-in; default off).

This is not Slack/Telegram ingress, Desk Remote, Firecracker, or a marketplace.

## API

| Method | Path |
| --- | --- |
| GET / POST | `/api/automations` |
| GET / PATCH / DELETE | `/api/automations/:id` |
| POST | `/api/automations/:id/run` (manual; `202` + `{ automation, session }`) |

## Web

`#/automations` directory: list, create, edit, enable, **立即运行**. Light Codex styling, Chinese labels.

Another same-host tab already on the page refreshes the **full list snapshot** (row add/remove, enable / cron / name, pins, plus **上次运行** / `lastSessionId` / `lastError`) from the existing `GET /api/automations` (focus / visibility / short poll). An already-open automation also `GET /api/automations/:id` **only while that id is still in the list**. Once the list lacks the open id, rewrite `#/automations/:id` (or `#/automations`) and clear or switch away — do **not** `GET /api/automations/:id`. List-visible updates even when detail is not open. 「立即运行」 / cron / pin stay the existing write paths. No new write path and no public webhook.

Deleting a **custom** expert, custom expert-team, or a project (existing `DELETE`) clears the matching `expertId` / `expertTeamId` / `projectId` on automations that still named that id. Built-in expert / team delete stays 400. An already-open `#/automations` list / detail catches up via the same Milestone AG GET (focus / visibility / short poll) — no ghost name, no new poller. Session pin cleanup stays Milestone AT / existing project-delete logic.

Deleting a session (existing `DELETE /api/sessions/:id`) clears `lastSessionId` on automations that still named that session. `lastRunAt` / `lastError`, pins, cron, and enabled stay put. The same Milestone AG GET (focus / visibility / short poll) drops the clickable last-session entry — no ghost link into the deleted session, no new poller. 「立即运行」 stays the existing run path.

## Out of scope

Public webhooks, Slack/Telegram, remote worker images, Desk Remote, Firecracker, marketplace, MySQL/Redis.
