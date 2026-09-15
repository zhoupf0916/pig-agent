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

Another same-host tab already on the page refreshes **上次运行** / `lastSessionId` / `lastError` from the existing `GET /api/automations` (focus / visibility / short poll). The selected item may also `GET /api/automations/:id`. List-visible last-run updates even when detail is not open. No new write path and no public webhook.

## Out of scope

Public webhooks, Slack/Telegram, remote worker images, Desk Remote, Firecracker, marketplace, MySQL/Redis.
