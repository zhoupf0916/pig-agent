# Local experts / playbooks

Milestone C. Neo-inspired **roles**, not a marketplace and not Cordis plugins.

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

Team `team_coding`（编码流水线）is `chain`: scout → plan → implement → review. The current runtime still runs **one** agent; team mode is metadata plus concatenated instructions when no single `expertId` is pinned.

Experts may list `skillIds` that already exist under `skills/`. Those names are preloaded into the pig / cloud-stub prompt. This is not a plugin install path.

## Session binding

`POST /api/sessions` and `PATCH /api/sessions/:id` accept `expertId` and `expertTeamId` (nullable to unbind).

Injection rules:

1. If `expertId` is set, that expert’s instruction is injected (the active role).
2. Else if `expertTeamId` is set, all member instructions are concatenated in team order.
3. Project instruction (Milestone A) is injected **after** the expert block when both are set.

**Precedence: expert then project.** Expert is the role for this turn; project is shared team context.

The same block is used by:

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

## Web

- `#/experts` directory: list, create custom, edit instruction, pin to the current session.
- Workstation header: 项目 / 专家 / 小队 selects. Light Codex styling, Chinese labels.

## Out of scope

Marketplace, remote worker images, Cordis, Desk Remote, Firecracker, billing.
