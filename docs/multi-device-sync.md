# Multi-device / multi-tab session sync

This is the Milestone A sync contract for Pig Agent. It is **inspired by** neo-cloud-agent’s “one event stream; late joiners pull a snapshot then follow with `after` / Last-Event-ID”. It is **not** a vendored copy of that repo, and it does not require Redis.

Workstation UX is unchanged: one `AgentEvent` protocol for pig / codex / cloud. Sync only fans those events out.

## Storage

| Path | Role |
| --- | --- |
| `data/sessions/<id>.json` | Session snapshot (messages, steps, artifacts, optional `projectId`) |
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

## What this is not

- No Redis / MySQL bus
- No OT / cursor sync
- No Desk Remote, Firecracker, or mobile Expo client
- Cloud runtime still uses the same `AgentEvent`s; this log lives on the pig-agent host
