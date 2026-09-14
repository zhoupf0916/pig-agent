# Local experts / playbooks

Milestone C (registry) + Milestone I (sequential chain runner). Neo-inspired **roles**, not a marketplace and not Cordis plugins.

Experts are JSON playbooks on this machine. Pinning one to a session injects its instruction into the current pig / Codex / cloud-stub system prompt. Workstation cards (chat, tools, artifacts) stay the same.

## Storage

| Path | Role |
| --- | --- |
| `data/experts/<id>.json` | One expert |
| `data/experts/teams/<id>.json` | Optional chain / parallel metadata |

First `GET /api/experts` seeds four bundled coding experts and one team if they are missing. Editing a bundled expert is allowed; deleting it is not (it would just be re-seeded).

## Bundled experts

| id | Name | Role |
| --- | --- | --- |
| `exp_scout` | 侦察 Scout | Explore and cite paths. Default: no file mutations. |
| `exp_plan` | 规划 Plan | Produce a plan + acceptance checks. Default: do not implement. |
| `exp_implement` | 实现 Implement | Small reviewable patches. Prefers local skill `coding-helper`. |
| `exp_review` | 评审 Review | Review existing work. Default: do not implement. |

Team `team_coding`（编码流水线）is `chain`: scout → plan → implement → review.

Experts may list `skillIds` that already exist under `skills/`. Those names are preloaded into the pig / cloud-stub prompt. This is not a plugin install path.

## Sequential chain (Milestone I)

**Strategy: same-session.** Members share one transcript and one artifact list. This is not handoff-per-step (no child session ids). Parallel-across-machines is out of scope.

When a session has `expertTeamId` with `mode: "chain"` and **no** `expertId`:

1. Each member is a separate pig (or current runtime) turn.
2. That turn injects **only that member’s** instruction, then project instruction, then in-scope memory pins (same as today).
3. A `[team]` marker and a hidden `[harness]` handoff nudge are appended before the member runs.
4. After the member goes idle, the runner **auto-continues** to the next member in the same HTTP/SSE request. Session `status` stays `running` until the pipeline finishes or is stopped.
5. Progress is persisted on `session.teamRun` (`currentIndex`, per-member status).

`expertId` still wins: the team is metadata only and the sequential runner does not start.

`mode: "parallel"` stays on the concatenated single-agent prompt (joint guidance). That is not fan-out.

### Team run state

```json
{
  "teamId": "team_coding",
  "teamName": "编码流水线",
  "strategy": "same-session",
  "status": "running",
  "currentIndex": 1,
  "members": [
    { "expertId": "exp_scout", "name": "侦察 Scout", "kind": "scout", "status": "done" },
    { "expertId": "exp_plan", "name": "规划 Plan", "kind": "plan", "status": "running" }
  ]
}
```

SSE event `team_run` carries the same object so the workstation pipeline chips update live.

## Session binding

`POST /api/sessions` and `PATCH /api/sessions/:id` accept `expertId` and `expertTeamId` (nullable to unbind). Unbinding a team clears `teamRun`.

Injection rules:

1. If `expertId` is set, that expert’s instruction is injected (the active role). Single turn.
2. Else if `expertTeamId` is a **chain** team, the sequential runner injects **one member per step**.
3. Else if `expertTeamId` is set (parallel, or playbook preview), all member instructions are concatenated in team order.
4. Project instruction (Milestone A) is injected **after** the expert block when both are set.
5. In-scope memory pins (Milestone H) are injected after expert+project on the pig loop only.

**Precedence: expert then project then pins.** Expert is the role for this turn; project is shared team context.

The same bound block is used by:

- pig `buildSystemPrompt`
- Codex `assembleCodexPrompt`
- cloud-stub (same pig loop)
- remote create-run: the block is prepended to `prompt` (no new control-plane fields, no secrets)

## API

| Method | Path |
| --- | --- |
| GET / POST | `/api/experts` |
| GET / PATCH / DELETE | `/api/experts/:id` |
| GET / POST | `/api/expert-teams` |
| GET / PATCH / DELETE | `/api/expert-teams/:id` |
| POST | `/api/sessions/:id/team-run` |

### `POST /api/sessions/:id/team-run`

```json
{ "action": "start" | "continue" | "stop", "content": "optional user prompt" }
```

| action | Behavior |
| --- | --- |
| `start` | Reset the pipeline and run every member. `content` becomes the user message; if omitted, the last real user message is reused. SSE. |
| `continue` | Resume the first pending / error / running / cancelled member (after stop or a failed step). SSE. |
| `stop` | Abort the in-flight turn and mark remaining members `cancelled`. |

A regular `POST /api/sessions/:id/messages` on a chain-team session (no `expertId`) also **starts** a sequential run, then auto-continues after each member idle. `POST /api/sessions/:id/abort` and the workstation **停止** button cancel the rest of the chain.

409 if the session is already running. 400 if no chain team is pinned, or if `expertId` is set.

## Web

- `#/experts` directory: list, create custom, edit instruction, pin to the current session.
- Workstation header: 项目 / 专家 / 小队 selects. Light Codex styling, Chinese labels.
- Team pin shows **小队流水线** chips (`pending` / `running` / `done` / `error`).
- Button **顺序执行小队** (or **继续小队** after a stop). Transcript `[team]` lines render as step markers.

## Out of scope

Marketplace, remote worker images, Cordis, Desk Remote, Firecracker, billing, parallel subagents across machines, environment builds.
