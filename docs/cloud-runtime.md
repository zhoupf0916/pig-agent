# Cloud execution surface (optional MVP)

Pig Agent’s default backend is still the built-in **pig** OpenAI-compatible tool-calling loop. Cloud is an **opt-in** execution surface — same workstation session / plan / tool / artifact semantics, different place the tools run.

This is **not** a fork or vendored copy of [neo-cloud-agent](https://github.com/Neo2Agent/neo-cloud-agent). We borrowed three principles only:

1. The client talks one protocol. Switching 本机 Pig / 本机 Codex / 云端 does not change UI cards.
2. A control path orchestrates; execution happens in an isolated worker workspace. **Provider keys stay on the host control path** (or a future gateway). They are never written into `data/cloud-runs/<id>/` or committed.
3. Mentally: **create run → stream events → IDLE / follow-up / abort**, mapped onto pig’s existing session SSE (`AgentEvent`).

## Security defaults

| Control | Default | Notes |
| --- | --- | --- |
| `runtime` | `pig` | Existing sessions keep the local pig loop |
| `cloudMode` | `local-stub` | CI and `pnpm test` need no cluster |
| Isolated workspace | `data/cloud-runs/<id>/workspace/` | Copy of the host workspace; `.env*` / `node_modules` / `.git` skipped |
| Provider keys | host settings / `.env.local` | Stub reuses the in-process pig loop; keys are not copied into the run dir |
| Remote payload | prompt + recent messages + model name | No `llmApiKey`, no `cloudToken`, no absolute local secrets |
| Abort | same `AbortSignal` as pig/codex | Stub cancels the inner loop; remote also `POST /v1/runs/:id/abort` |

Never commit API keys or control-plane tokens. Use `.env.local` (gitignored) or the Settings UI (writes `data/settings.json`, also gitignored).

## Modes

### `local-stub` (default)

When Settings → 云端 and mode is `local-stub` (or no remote URL is configured):

1. Allocate `run_<id>` under `data/cloud-runs/`.
2. Copy the configured workspace into `…/workspace/` (secrets files skipped).
3. Write `run.json` (id / session id / timestamp only — no keys).
4. Run the existing pig loop against that copy.
5. Mirror artifact files back to the host workspace so the right-hand tree / preview stay consistent.
6. Emit the same `AgentEvent` stream the UI already understands.

This is how automated tests and offline smoke work.

### `remote`

When mode is `remote` and `cloudBaseUrl` is set, the host is a **client** of a future control plane:

1. `POST {cloudBaseUrl}/v1/runs`
2. `GET {cloudBaseUrl}/v1/runs/{id}/events` (SSE)
3. Map inbound frames onto pig `AgentEvent`s
4. On stop: abort the SSE and `POST /v1/runs/{id}/abort`

This MVP does **not** upload the local workspace tree to the remote plane. A later control plane that actually provisions workers should accept a workspace snapshot or repo hint; the workstation UI does not need to change.

## Minimal control-plane contract

`cloudBaseUrl` is the **origin** (trailing `/` and a redundant `/v1` are stripped). Optional `Authorization: Bearer <cloudToken>`.

### `POST /v1/runs`

```json
{
  "prompt": "整理工作区并写一份报告",
  "sessionId": "ses_…",
  "messages": [
    { "id": "msg_…", "role": "user", "content": "…", "createdAt": "…" }
  ],
  "model": "deepseek-chat"
}
```

Response: `{ "id": "run_…", "status": "running" }` (`runId` or `{ run: { id } }` also accepted).

Do **not** put provider keys in this body. Inference should go through a gateway the worker cannot read.

### `GET /v1/runs/{id}/events`

SSE. Each `data:` line is JSON. Pig-shaped events pass through; neo-inspired aliases are mapped:

| Inbound `type` | Pig `AgentEvent` |
| --- | --- |
| `token` / `assistant.delta` | `token` |
| `message` / `assistant.message` | `message` |
| `tool_start` / `tool.started` | `tool_start` |
| `tool_end` / `tool.finished` | `tool_end` |
| `steps` / `plan.updated` | `steps` |
| `artifact` / `artifact.upserted` | `artifact` |
| `run.started` | `status: running` |
| `run.idle` / `done` | `status: idle` then host emits `done` with the accumulated session |
| `run.error` / `error` | `error` |

Unknown types are dropped so a richer plane cannot break the workstation.

### `POST /v1/runs/{id}/abort`

`{ "ok": true }`. Pig’s **停止** button already aborts the host `AbortSignal`; the cloud runtime also notifies the plane.

### `POST /v1/runs/{id}/follow-ups` (documented, not sent yet)

`{ "prompt": "…" }` — neo-style follow-up / steer while IDLE or RUNNING. This MVP starts a **new** `/v1/runs` per user turn and includes recent messages, so the UI multi-turn path works without storing a remote run id. A later host can switch to follow-ups without changing cards.

## Pointing at a future real control plane

```bash
# .env.local (gitignored)
PIG_CLOUD_MODE=remote
PIG_CLOUD_BASE_URL=http://127.0.0.1:8080
PIG_CLOUD_TOKEN=          # optional
# optional isolated stub dir (default ./data/cloud-runs)
# PIG_CLOUD_RUNS_DIR=./data/cloud-runs
```

Or Settings → 云端 → remote → paste the origin. Then implement the four routes above. The workstation does not embed Firecracker, an LLM gateway, or a worker image.

## What we deliberately did not copy from neo-cloud-agent

- Cordis plugins / extension marketplace
- Firecracker / Docker / VM slot runtimes
- Desk Remote / Electron / mobile / admin platform
- Java `neo-loop` / AgentScope
- Monorepo split (`packages/control-plane`, `llm-gateway`, `worker`, …)
- MySQL / Redis / object-store transcript archive
- Multi-tenant accounts, SCM commit/PR tools, experts
- Uploading Provider keys into a worker env file

Those stay out of pig-agent. The seam is the small HTTP+SSE contract and the `AgentRuntime = "cloud"` switch.

## Smoke (no live DeepSeek)

```bash
pnpm test                 # includes local-stub + scripted LLM
pnpm typecheck
```

Manual: `pnpm mock:llm`, Settings → 云端 → local-stub, send a “写一个文件” turn. See [MANUAL_TEST.md](../MANUAL_TEST.md).
