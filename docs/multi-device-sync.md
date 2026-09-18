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

## Open Settings form (Milestone AH)

When Tab B already has Settings open, non-secret form fields (llm / workspace / cloud / codex, etc.) are a **read-only** refresh of the same `GET /api/settings` used by the Milestone R chip. Another same-host tab that saves those fields updates Tab B's form on focus, visibility, or a short poll — no full page reload. In-progress secret inputs (`llmApiKey` / `cloudToken`) are not overwritten or synced. Save still uses the existing PUT. Default runtime stays **pig**. This does **not** add a write path, a public webhook, or dual-write settings / sessions / `events.jsonl`.

## Composer drafts (Milestone S)

Unsent workstation composer text stays in the existing client-only `localStorage` key `pig-agent.composer-drafts` (Milestone P). Another same-host tab on the **same `sessionId`** applies Tab A's typing / clear / send through the `storage` event, or by re-reading the store on focus / visibility — no full page reload. Different sessions do not overwrite each other. This does **not** persist drafts on the server or dual-write settings / sessions / `events.jsonl`.

## Workspace browser tree (Milestone T)

The workstation workspace tree is a **read-only** refresh of `GET /api/workspace/tree`. Another tab on the same host that creates or modifies sandbox files during a turn updates Tab B's tree on focus, visibility, or a short poll — no full page reload. Nodes stay name / path / type / size (no file contents). This does **not** dual-write workspace files, session JSON, or `events.jsonl`. Default runtime stays **pig**. Sandbox boundary is unchanged.

## Workspace file preview (Milestone U)

When Tab B already has a sandbox path open in the preview pane, that preview is a **read-only** refresh of `GET /api/workspace/file`. Another same-host tab that modifies that same path during a turn updates Tab B's preview on focus, visibility, or a short poll — no full page reload. Change detection uses the existing snapshot `size` plus content (no new write path, no ETag header). Secrets in file text are redacted with the existing display helper. This is orthogonal to Milestone T (tree listing only). It does **not** dual-write workspace files, session JSON, or `events.jsonl`. Default runtime stays **pig**. Sandbox boundary is unchanged.

## Open workspace preview deleted elsewhere (Milestone AO)

When Tab B already has a sandbox path open in the preview pane, the same read-only `GET /api/workspace/file` used by Milestone U is also the source of truth for whether that path still exists. Another same-host tab that **deletes or moves** the file updates Tab B on focus, visibility, or a short poll — no full page reload. If the GET confirms 404 / `Path not found`, clear the preview in place (empty — no ghost body text) without remounting the workbench. Tree listing still follows Milestone T. Content refresh while the file still exists still follows Milestone U. This does **not** add a write path, a public webhook, or dual-write workspace files, session JSON, or `events.jsonl`. Default runtime stays **pig**. Sandbox boundary is unchanged.

## Theme (Milestone V)

Light / dark stays in the existing client-only `localStorage` key `pig-agent.theme` (Milestone J2). Another same-host tab applies Tab A's header toggle through the `storage` event, or by re-reading the key on focus / visibility — no full page reload. This does **not** invent a second key, persist theme on the server, or dual-write settings / sessions / `events.jsonl`. Default runtime stays **pig**.

## Session pins (Milestone Y)

When Tab B is already showing a session, the chat-header pin row (项目 / 专家 / 小队) is a **read-only** refresh of those fields from `GET /api/sessions`. Another same-host tab that binds or unbinds (「未绑定」) updates Tab B's dropdowns / hints on focus, visibility, or a short poll — no full page reload. Apply patches only the pin fields on the open session (transcript / steps stay put). This does **not** add a write path, a second pin store, or dual-write `events.jsonl`. Default runtime stays **pig**. Catalog option lists (create / rename / delete) are Milestone AK.

## Session pins after expert / team delete (Milestone AT)

Deleting a **custom** expert or custom expert-team clears matching session pins on the existing `DELETE` — `expertId` for the expert, `expertTeamId` plus `teamRun` (if any) for the team — the same unbind as PATCH null. Built-in experts / teams stay undeletable (existing 400). Automation records that named the id are Milestone AU.

When Tab B is already showing a session, the chat-header pin row is the existing Milestone Y **read-only** refresh of those fields from `GET /api/sessions`. Another same-host tab that deletes the pinned custom expert / team updates Tab B's dropdowns / hints to 「未绑定」 on focus, visibility, or a short poll — no ghost name, no full page reload, no new sync stack. Catalog option lists still follow Milestone AK. Pin writes still use the existing session PATCH. This does **not** add a write path, a public webhook, or dual-write sessions / `events.jsonl`. Default runtime stays **pig**.

## Workbench pin-dropdown catalogs (Milestone AK)

When Tab B is already on the workbench, the chat-header 项目 / 专家 / 小队 **option lists** are a **read-only** refresh of the existing `GET /api/projects` + `GET /api/experts` + `GET /api/expert-teams`. Another same-host tab that creates, renames, or deletes a project / expert / team updates Tab B's dropdown catalogs on focus, visibility, or a short poll — no full page reload. Pin binding still uses the existing session PATCH paths (Milestone Y). This does **not** add a write path, a public webhook, or dual-write projects / experts / sessions / `events.jsonl`. Default runtime stays **pig**. Dropdown / snapshot JSON never carry provider-key plaintext.

## Open session title / status (Milestone AM)

When Tab B is already showing a session, the open session's `title` / `status` is a **read-only** refresh of those fields from the same `GET /api/sessions` used by the sidebar (Milestone Q) and pin row (Milestone Y). Another same-host tab that renames or flips running↔idle updates Tab B on focus, visibility, or a short poll — no full page reload. Apply patches only title / status on the open session (transcript / steps stay put). Pins still follow Milestone Y. This does **not** add a write path, a public webhook, or dual-write `events.jsonl`. Default runtime stays **pig**.

## Open session deleted elsewhere (Milestone AN)

When Tab B is already showing a session, the same read-only `GET /api/sessions` used by the sidebar (Milestone Q) and title / status (Milestone AM) is also the source of truth for whether that open id still exists. Another same-host tab that **deletes** the session updates Tab B on focus, visibility, or a short poll — no full page reload. If the open id is absent, clear the open state or switch to the next sidebar session. Rewrite `#/sessions/:id` (or `#/`) **before** any per-id load so a stale hash cannot `GET /api/sessions/:deletedId`. Do **not** fetch the deleted row and do **not** reload other sessions' transcripts except the next sidebar row when switching. Delete still uses the existing `DELETE /api/sessions/:id`. This does **not** add a write path, a public webhook, or dual-write `events.jsonl`. Default runtime stays **pig**.

## Automations list last-run (Milestone Z)

When Tab B is already on `#/automations`, the directory list is a **read-only** refresh of last-run fields from `GET /api/automations` (`lastRunAt` / `lastSessionId` / `lastError`). Another same-host tab or the in-process cron that finishes a run updates Tab B's 上次运行 / session entry / error on focus, visibility, or a short poll — no full page reload. Apply patches only those last-run fields onto existing list rows (and the open detail, which may also `GET /api/automations/:id`). List-visible last-run updates even when detail is not open. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. 「立即运行」 / `409` in-flight stays the existing run path. Default runtime stays **pig**.

## Automations directory (Milestone AG)

When Tab B is already on `#/automations`, the directory is a **read-only** refresh of the **full** `GET /api/automations` snapshot — not only last-run fields. Another same-host tab that creates or deletes a row, or toggles enable / changes cron / renames, updates Tab B's list (and the already-open detail, which may also `GET /api/automations/:id`) on focus, visibility, or a short poll — no full page reload. Last-run fields still catch up as in Milestone Z. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. 「立即运行」 / `409` in-flight stays the existing run path. Default runtime stays **pig**.

## Open automation detail deleted elsewhere (Milestone AS)

When Tab B is already on `#/automations` with an automation open, the same read-only `GET /api/automations` used by Milestone AG is also the source of truth for whether that open id still exists. Another same-host tab that **deletes** the automation updates Tab B on focus, visibility, or a short poll — no full page reload. If the list snapshot lacks the open id, rewrite hash / open state first (clear the detail, or switch to the next list row). Do **not** `GET /api/automations/:id` after the list confirms the id is gone (AN-02 nail). Delete still uses the existing `DELETE /api/automations/:id`. List / last-run / open-detail catch-up while the automation still exists still follow Milestone AG / Z. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. 「立即运行」 / `409` in-flight stays the existing run path. Default runtime stays **pig**.

## Automation pins after expert / team / project delete (Milestone AU)

Deleting a **custom** expert, custom expert-team, or a project clears the matching field on automation records — `expertId` / `expertTeamId` / `projectId` — the same unbind as PATCH null. Built-in experts / teams stay undeletable (existing 400). Session pin cleanup stays Milestone AT / existing project-delete logic.

When Tab B is already on `#/automations`, the directory (and already-open detail) is the existing Milestone AG **read-only** refresh of `GET /api/automations`. Another same-host tab that deletes the pinned custom expert / team / project updates Tab B on focus, visibility, or a short poll — no ghost name, no full page reload, no new sync stack. Last-run still follows Milestone Z. Open-detail-deleted-elsewhere still follows Milestone AS. 「立即运行」 / cron / enabled stay the existing run path. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. Default runtime stays **pig**.

## Automation lastSessionId after session delete (Milestone AW)

Deleting a session clears `lastSessionId` on automations that still name that session — the same field-null as PATCH. `lastRunAt` / `lastError`, expert / team / project pins, cron, and enabled stay put. Inbox cleanup is Milestone AX. Memory `sessionId` cleanup stays Milestone AV.

When Tab B is already on `#/automations`, the directory (and already-open detail) is the existing Milestone AG **read-only** refresh of `GET /api/automations`. Another same-host tab that deletes that last-run session updates Tab B on focus, visibility, or a short poll — no clickable ghost entry into the deleted session, no full page reload, no new sync stack. Last-run field apply still follows Milestone Z. Open-detail-deleted-elsewhere still follows Milestone AS. Pin cleanup still follows Milestone AU. 「立即运行」 / cron / enabled stay the existing run path. This does **not** add a write path, a public webhook, or dual-write automations / sessions / `events.jsonl`. Default runtime stays **pig**.

## Projects board / assets / members (Milestone AA)

When Tab B is already on `#/projects` with a project open, the board / assets / members sections are a **read-only** refresh of the existing `GET /api/projects` plus `GET /api/projects/:id`. Another same-host tab that changes a todo status, uploads an asset, or invite·accepts a member updates Tab B on focus, visibility, or a short poll — no full page reload. Apply patches only those collections (and list-side name / `updatedAt`) onto the open project; instruction draft / invite token stay put. Detail GET runs only when that project is open. This does **not** add a write path, a public webhook, or dual-write projects / sessions / `events.jsonl`. Invite / transfer stay the existing paths. Default runtime stays **pig**.

## Open project detail deleted elsewhere (Milestone AP)

When Tab B is already on `#/projects` with a project open, the same read-only `GET /api/projects` used by Milestone AA is also the source of truth for whether that open id still exists. Another same-host tab that **deletes** the project updates Tab B on focus, visibility, or a short poll — no full page reload. If the list snapshot lacks the open id, rewrite hash / open state first (clear the board, or switch to the next list row). Do **not** `GET /api/projects/:id` after the list confirms the id is gone (AN-02 nail). Delete still uses the existing `DELETE /api/projects/:id`. Board / assets / members while the project still exists still follow Milestone AA. This does **not** add a write path, a public webhook, or dual-write projects / sessions / `events.jsonl`. Default runtime stays **pig**.

## Project asset / todo session refs after session delete (Milestone AZ)

Deleting a session clears matching project-internal refs — asset `sourceSessionId` and todo `sessionId` — on the existing `DELETE /api/sessions/:id`. Assets and todos themselves stay. Todo title / status are not rewritten. Activity-feed body text is not rewritten. Inbox / memory / automation / team cleanup stay AX / AV / AW / AY.

When Tab B is already on `#/projects` with a project open, the board / assets sections are the existing Milestone AA **read-only** refresh of `GET /api/projects` plus `GET /api/projects/:id`. Another same-host tab that deletes the source session updates Tab B on focus, visibility, or a short poll — no clickable 「来源会话」 into the deleted session, no full page reload, no new sync stack. Open-project-deleted-elsewhere still follows Milestone AP. Do **not** `GET /api/sessions/:deletedId` after list / detail says that session is gone (AN-02). This does **not** add a write path, a public webhook, or dual-write projects / sessions / `events.jsonl`. Default runtime stays **pig**.

## Memory directory (Milestone AB)

When Tab B is already on `#/memory`, the note list is a **read-only** refresh of the existing `GET /api/memory`. Another same-host tab (or the workstation **钉住笔记** / **写摘要** write) that pins, edits, or deletes a note updates Tab B's list on focus, visibility, or a short poll — no full page reload. An already-open detail also `GET /api/memory/:id`; that body is **not** force-fetched when the note is not open. Apply list / detail patches in place (no remount). This does **not** add a write path, a public webhook, or dual-write memory / sessions / `events.jsonl`. Pin / write-summary / search stay the existing paths. Default runtime stays **pig**.

## Open memory note deleted elsewhere (Milestone AQ)

When Tab B is already on `#/memory` with a note open, the same read-only `GET /api/memory` used by Milestone AB is also the source of truth for whether that open id still exists. Another same-host tab that **deletes** the note updates Tab B on focus, visibility, or a short poll — no full page reload. If the list snapshot lacks the open id, rewrite hash / open state first (clear the detail, or switch to the next list row). Do **not** `GET /api/memory/:id` after the list confirms the id is gone (AN-02 nail). Delete still uses the existing `DELETE /api/memory/:id`. List / open-detail catch-up while the note still exists still follow Milestone AB. This does **not** add a write path, a public webhook, or dual-write memory / sessions / `events.jsonl`. Default runtime stays **pig**.

## Memory refs after project / session delete (Milestone AV)

Deleting a project or a session clears the matching field on memory notes — `projectId` / `sessionId` — the same unbind as PATCH null. Note body / tags are not rewritten. Inbox cleanup is Milestone AX. Automation `lastSessionId` is Milestone AW.

When Tab B is already on `#/memory`, the list (and already-open detail) is the existing Milestone AB **read-only** refresh of `GET /api/memory`. Another same-host tab that deletes the referenced project / session updates Tab B on focus, visibility, or a short poll — no clickable ghost entry into the deleted project / session, no full page reload, no new sync stack. Open-note-deleted-elsewhere still follows Milestone AQ. Pin / write-summary stay the existing write paths. This does **not** add a write path, a public webhook, or dual-write memory / sessions / `events.jsonl`. Default runtime stays **pig**.

## Experts directory (Milestone AC)

When Tab B is already on `#/experts`, the expert list (and team list) is a **read-only** refresh of the existing `GET /api/experts` plus `GET /api/expert-teams`. Another same-host tab that creates, edits, or deletes an expert — or changes the expert-team list — updates Tab B on focus, visibility, or a short poll — no full page reload. An already-open detail also `GET /api/experts/:id`; that body is **not** force-fetched when the expert is not open. Apply list / team / detail patches in place (no remount). This does **not** add a write path, a public webhook, or dual-write experts / sessions / `events.jsonl`. Session pin / sequential expert-team run stay the existing paths. Default runtime stays **pig**.

## Open expert detail deleted elsewhere (Milestone AR)

When Tab B is already on `#/experts` with an expert open, the same read-only `GET /api/experts` used by Milestone AC is also the source of truth for whether that open id still exists. Another same-host tab that **deletes** the expert updates Tab B on focus, visibility, or a short poll — no full page reload. If the list snapshot lacks the open id, rewrite hash / open state first (clear the detail, or switch to the next list row). Do **not** `GET /api/experts/:id` after the list confirms the id is gone (AN-02 nail). Delete still uses the existing `DELETE /api/experts/:id`. Teams list GET still allowed. List / team / open-detail catch-up while the expert still exists still follow Milestone AC. This does **not** add a write path, a public webhook, or dual-write experts / sessions / `events.jsonl`. Default runtime stays **pig**.

## Team expertIds after custom expert delete (Milestone AY)

Deleting a **custom** expert (existing `DELETE /api/experts/:id`) also drops that id from every expert team's `expertIds`. Remaining members keep their order. A team that becomes empty is **not** auto-deleted (the user may delete it manually). Built-in experts stay undeletable (existing 400). Session pins stay Milestone AT; automation pins stay Milestone AU.

When Tab B is already on `#/experts`, the team list is the existing Milestone AC **read-only** refresh of `GET /api/expert-teams`. The workbench 专家 / 小队 pin-dropdown catalogs reuse Milestone AK (`GET /api/experts` + `GET /api/expert-teams`). Another same-host tab that deletes the custom expert updates Tab B on focus, visibility, or a short poll — no ghost member, no full page reload, no new sync stack. Sequential team-run for remaining members stays the existing path. This does **not** add a write path, a public webhook, or dual-write experts / sessions / `events.jsonl`. Default runtime stays **pig**.

## Settings skills list (Milestone AJ)

When Tab B already has Settings open, the `skills/` list is a **read-only** refresh of the existing `GET /api/skills`. Another same-host tab that adds, edits, or deletes `skills/*.md` updates Tab B's list on focus, visibility, or a short poll — no full page reload. This does **not** add a write path, a public webhook, or dual-write skills / settings / sessions / `events.jsonl`. `list_skills` / `load_skill` stay the existing tools. Codex MVP still does not bridge Pig skills. Default runtime stays **pig**. List / snapshot JSON never carry provider-key plaintext or skill body.

## Search results (Milestone AI)

When Tab B is already on `#/search` **with a query**, the hit list is a **read-only** refresh of the existing `GET /api/search?q=`. Another same-host tab that changes a session title, project fields, or memory note updates Tab B's same-query hits on focus, visibility, or a short poll — no full page reload. No query → do not force-fetch. Apply the hit list in place (no remount). This does **not** add a write path, a public webhook, or dual-write search / sessions / `events.jsonl`. Header box / Enter / `#/search` navigation stay the existing paths. Default runtime stays **pig**. Hit list / snapshot JSON never carry provider-key plaintext.

## Top-bar SearchBox (Milestone AL)

When Tab B's header `SearchBox` already has a query **and** the dropdown is open, the hit list is a **read-only** refresh of the same `GET /api/search?q=` used by Milestone AI's `#/search`. Another same-host tab that changes a session title, project fields, or memory note updates Tab B's same-query dropdown hits on focus, visibility, or a short poll — no full page reload. No query, or dropdown closed → do not force-fetch. Apply the hit list in place (no remount). This does **not** add a write path, a public webhook, or dual-write search / sessions / `events.jsonl`. Header box / Enter / `#/search` navigation stay the existing paths. Default runtime stays **pig**. Hit list / snapshot JSON never carry provider-key plaintext.

## Inbox menu (Milestone AF)

The header inbox (unread badge + list) is a **read-only** refresh of the existing `GET /api/inbox`. Another same-host tab that creates an invite / transfer, or marks read / accept / ignore, updates Tab B on focus, visibility, or a short poll — no full page reload. Apply patches to the badge count and list rows in place (no remount). Accept / decline / read stay the existing POSTs. This does **not** add a write path, a public webhook, or dual-write inbox / sessions / `events.jsonl`. Default runtime stays **pig**. Menu / badge / snapshot JSON never carry invite tokens or provider-key plaintext.

## Inbox refs after session / project delete (Milestone AX)

Deleting a session clears `sessionId` on inbox items that still name that session. Title / body / read / invite fields stay. Deleting a project **removes** inbox items with that `projectId` (invite and handoff). Invite / transfer stay the existing kinds — no archive / history model.

When Tab B already has the header inbox, it is the existing Milestone AF **read-only** refresh of `GET /api/inbox`. Another same-host tab that deletes that session / project updates Tab B on focus, visibility, or a short poll — no clickable ghost entry into the deleted session / project, no full page reload, no new sync stack. Accept / decline / read stay the existing POSTs. This does **not** add a write path, a public webhook, or dual-write inbox / sessions / `events.jsonl`. Default runtime stays **pig**. Menu / badge / snapshot JSON never carry invite tokens or provider-key plaintext.

## What this is not

- No Redis / MySQL bus
- No OT / cursor sync
- No Desk Remote, Firecracker, or mobile Expo client
- Cloud runtime still uses the same `AgentEvent`s; this log lives on the pig-agent host
