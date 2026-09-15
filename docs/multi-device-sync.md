# Multi-device / multi-tab session sync

This is the Milestone A sync contract for Pig Agent. It is **inspired by** neo-cloud-agent’s “one event stream; late joiners pull a snapshot then follow with `after` / Last-Event-ID”. It is **not** a vendored copy of that repo, and it does not require Redis.

Workstation UX is unchanged: one `AgentEvent` protocol for pig / codex / cloud. Sync only fans those events out.

## Storage

| Path | Role |
| --- | --- |
| `data/sessions/<id>.json` | Session snapshot (messages, steps, artifacts, optional `projectId` / `expertId` / `expertTeamId`) |
| `data/sessions/<id>/events.jsonl` | Append-only ordered event log |

Each JSONL line:

```json
{ "seq": 1, "ts": "2026-09-14T11:00:00.000Z", "event": { "type": "token", "text": "你好" } }
```

`seq` is monotonic per session, starting at `1`. `session.eventCheckpointSeq` is stamped on every `saveSession` and is the snapshot cursor.

## Client contract

Late joiner (second tab / other device):

1. `GET /api/sessions/:id` — transcript snapshot.
2. `GET /api/sessions/:id/events?after=<eventCheckpointSeq>` — catch-up + live SSE.

`after` is exclusive. If omitted, the server also honors `Last-Event-ID`.

SSE frames:

```
id: 12
event: token
data: {"type":"token","text":"…"}
```

`id` is the seq. Reconnect with `?after=<last seen id>` or `Last-Event-ID`.

## Disconnect / reconnect (Milestone O)

A dropped SSE (second tab already subscribed, another device, network blip) resumes from the last seen event. It does **not** reload the session snapshot or replay seq `1…lastSeen`.

1. Client keeps the last seen SSE `id` (monotonic seq).
2. Reconnect `GET /api/sessions/:id/events?after=<lastSeen>` and send `Last-Event-ID: <lastSeen>` (`after` wins if both are present).
3. Server attaches to the in-process bus first, then reads the gap from the existing `events.jsonl` (same `publishPersistedEvent` write path — no second log).
4. Only `seq > after` is written to the new stream. Transient `sync` frames mark catch-up vs live and are **not** persisted.

```
event: sync
data: {"type":"sync","phase":"catching_up","after":3,"lastSeq":5,"gap":2}

id: 4
event: token
data: {"type":"token","text":"…"}

event: sync
data: {"type":"sync","phase":"live","after":3,"lastSeq":5,"gap":0}
```

The workstation shows **正在追平未送达事件…** while `gap > 0`, then returns to idle (or the session status from the replayed events). A completed turn that finished while disconnected still ends idle.

Catch-up without holding a stream (tests / scripts):

```
GET /api/sessions/:id/events?after=3&live=0
```

```json
{
  "after": 3,
  "lastSeq": 7,
  "events": [{ "seq": 4, "ts": "…", "event": { "type": "token", "text": "…" } }]
}
```

## Fan-out

`POST /api/sessions/:id/messages` still streams to the sender (backward compatible). Every emitted `AgentEvent` is also:

1. Appended to `events.jsonl` with the next seq
2. Published to every in-process subscriber of that session

So two `GET …/events` clients on the same session see the **same seq sequence**. The web UI dedupes by seq so the sending tab (POST stream + GET subscribe) does not double-apply tokens.

The live `GET …/events` connection stays open after a turn ends, so a follow-up from another tab arrives without a full page reload.

## Sidebar status (Milestone Q)

Transcript SSE is per-session. The workstation sidebar is a **read-only** refresh of `GET /api/sessions` (status / title / `updatedAt`). Another tab on the same host that starts or finishes a turn does not need a full page reload. This does **not** dual-write session JSON or append `events.jsonl`.

## Execution-surface chip (Milestone R)

The top-bar runtime chip (本机 Pig / 本机 Codex / 云端) is a **read-only** refresh of `GET /api/settings`. Another same-host tab that saves a runtime change in Settings updates the chip on focus, visibility, or a short poll — no full page reload. Chip copy still comes from the existing execution-surface descriptors. Default runtime stays **pig**. This does **not** PUT settings or write sessions / `events.jsonl`.

## Composer drafts (Milestone S)

Unsent workstation composer text stays in the existing client-only `localStorage` key `pig-agent.composer-drafts` (Milestone P). Another same-host tab on the **same `sessionId`** applies Tab A's typing / clear / send through the `storage` event, or by re-reading the store on focus / visibility — no full page reload. Different sessions do not overwrite each other. This does **not** persist drafts on the server or dual-write settings / sessions / `events.jsonl`.

## Workspace browser tree (Milestone T)

The workstation workspace tree is a **read-only** refresh of `GET /api/workspace/tree`. Another tab on the same host that creates or modifies sandbox files during a turn updates Tab B's tree on focus, visibility, or a short poll — no full page reload. Nodes stay name / path / type / size (no file contents). This does **not** dual-write workspace files, session JSON, or `events.jsonl`. Default runtime stays **pig**. Sandbox boundary is unchanged.

## Workspace file preview (Milestone U)

When Tab B already has a sandbox path open in the preview pane, that preview is a **read-only** refresh of `GET /api/workspace/file`. Another same-host tab that modifies that same path during a turn updates Tab B's preview on focus, visibility, or a short poll — no full page reload. Change detection uses the existing snapshot `size` plus content (no new write path, no ETag header). Secrets in file text are redacted with the existing display helper. This is orthogonal to Milestone T (tree listing only). It does **not** dual-write workspace files, session JSON, or `events.jsonl`. Default runtime stays **pig**. Sandbox boundary is unchanged.

## Theme (Milestone V)

Light / dark stays in the existing client-only `localStorage` key `pig-agent.theme` (Milestone J2). Another same-host tab applies Tab A's header toggle through the `storage` event, or by re-reading the key on focus / visibility — no full page reload. This does **not** invent a second key, persist theme on the server, or dual-write settings / sessions / `events.jsonl`. Default runtime stays **pig**.

## Session pins (Milestone Y)

When Tab B is already showing a session, the chat-header pin row (项目 / 专家 / 小队) is a **read-only** refresh of those fields from `GET /api/sessions`. Another same-host tab that binds or unbinds (「未绑定」) updates Tab B's dropdowns / hints on focus, visibility, or a short poll — no full page reload. Apply patches only the pin fields on the open session (transcript / steps stay put). This does **not** add a write path, a second pin store, or dual-write `events.jsonl`. Default runtime stays **pig**.

## Automations list last-run (Milestone Z)

When Tab B is already on `#/automations`, the directory list is a **read-only** refresh of last-run fields from `GET /api/automations` (`lastRunAt` / `lastSessionId` / `lastError`). Another same-host tab or the in-process cron that finishes a run updates Tab B's 上次运行 / session entry / error on focus, visibility, or a short poll — no full page reload. Apply patches only those last-run fields onto existing list rows (and the open detail, which may also `GET /api/automations/:id`). List-visible last-run updates even when detail is not open. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. 「立即运行」 / `409` in-flight stays the existing run path. Default runtime stays **pig**.

## Projects board / assets / members (Milestone AA)

When Tab B is already on `#/projects` with a project open, the board / assets / members sections are a **read-only** refresh of the existing `GET /api/projects` plus `GET /api/projects/:id`. Another same-host tab that changes a todo status, uploads an asset, or invite·accepts a member updates Tab B on focus, visibility, or a short poll — no full page reload. Apply patches only those collections (and list-side name / `updatedAt`) onto the open project; instruction draft / invite token stay put. Detail GET runs only when that project is open. This does **not** add a write path, a public webhook, or dual-write projects / sessions / `events.jsonl`. Invite / transfer stay the existing paths. Default runtime stays **pig**.

## What this is not

- No Redis / MySQL bus
- No OT / cursor sync
- No Desk Remote, Firecracker, or mobile Expo client
- Cloud runtime still uses the same `AgentEvent`s; this log lives on the pig-agent host
