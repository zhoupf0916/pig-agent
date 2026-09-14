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
| Isolated workspace | `data/cloud-runs/<id>/workspace/` | Copy of the host workspace; `.env*` / keys / `node_modules` / `.git` skipped |
| Provider keys | host settings / `.env.local` | Stub reuses the in-process pig loop; keys are not copied into the run dir |
| Remote payload | prompt + recent messages + model + workspace handoff | No `llmApiKey`, no `cloudToken`, no absolute local secrets |
| Abort | same `AbortSignal` as pig/codex | Stub cancels the inner loop; remote also `POST /v1/runs/:id/abort` |
| Follow-up | last `remoteRunId` on the pig session | IDLE turns `POST /v1/runs/:id/follow-ups`; missing/expired → new create-run |

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

When mode is `remote` and `cloudBaseUrl` is set, the host is a **client** of a control plane (real or `pnpm mock:cloud`):

1. First turn (or after an expired run): `POST {cloudBaseUrl}/v1/runs` with prompt + recent messages + a workspace handoff
2. Persist the returned `runId` on the pig session as `remoteRunId`
3. `GET {cloudBaseUrl}/v1/runs/{id}/events` (SSE) → map onto pig `AgentEvent`s
4. Later IDLE user turns: `POST /v1/runs/{id}/follow-ups` then subscribe to events again
5. If follow-up returns 404/410 (or the run id is missing): fall back to a new `POST /v1/runs` with a fresh snapshot
6. On stop: abort the SSE and `POST /v1/runs/{id}/abort` (the session still keeps `remoteRunId` so the next message can follow up)

### Workspace handoff

`POST /v1/runs` may include `workspace`. Pig always tries to send a **tar.gz snapshot** of the configured sandbox. You can also set a **non-secret repo hint** so a plane can clone instead of (or in addition to) unpacking the archive.

Precedence for remote-cloud hints (each field independently; empty Settings fields fall through):

1. **Settings / UI** (`data/settings.json` — `cloudBaseUrl`, `cloudRepoUrl`, `cloudRepoRef`)
2. **`env.json`** at the repo root (copy [`env.json.example`](../env.json.example); gitignored)
3. **Process env** (`PIG_CLOUD_BASE_URL` / `CLOUD_BASE_URL`, `PIG_CLOUD_REPO_URL`, `PIG_CLOUD_REPO_REF`)

`env.json` is discoverable in Settings → 云端 → remote (status + **填入 env.json 提示**). It must not contain tokens or API keys — those stay in `.env.local` or the Settings token field. The loader drops keys matching `token` / `apiKey` / `password` / `secret` even if someone adds them.

| Uploaded | Skipped |
| --- | --- |
| Regular files under the workspace root (text + small binaries) | `.env`, `.env.*` (any env file) |
| | Private key names: `id_rsa` / `id_ed25519` / `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.keystore` |
| | `node_modules`, `.git`, `.ssh`, `data`, `dist`, `.vite`, `coverage` |
| | Symlinks, non-files, paths > 100 chars, files > 512 KiB |
| | Archive over 4 MiB uncompressed / 400 files (`truncated: true`) |

The snapshot is `gzip(ustar)` base64. The plane must not treat it as a place to inject provider keys. `assertNoSecretsInPayload` refuses to send if `llmApiKey` or `cloudToken` appears anywhere in the JSON (including file bytes).

Follow-ups do **not** re-upload the tree; the worker is expected to keep its workspace.

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
  "model": "deepseek-chat",
  "workspace": {
    "snapshot": {
      "encoding": "tar.gz",
      "data": "<base64 gzip ustar>",
      "files": ["README.md", "notes/todo.txt"],
      "skipped": [".env", "node_modules", ".git"],
      "byteSize": 1234
    },
    "repoUrl": "https://github.com/acme/app.git",
    "ref": "main"
  }
}
```

`workspace.snapshot` is omitted only when the workspace root is missing. `repoUrl` / `ref` are omitted unless Settings, `env.json`, or `PIG_CLOUD_REPO_*` supplies them.

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

### `POST /v1/runs/{id}/follow-ups`

`{ "prompt": "…" }` — neo-style follow-up / steer after the previous turn went IDLE (also accepted while RUNNING). Response `{ "ok": true, "id": "run_…" }`.

The workstation persists `remoteRunId` on the session JSON (`data/sessions/<id>.json`). The next user message prefers this route. **404 / 410 / network miss** → new `POST /v1/runs` with a fresh snapshot. No UI card changes.

## Pointing at a future real control plane

```bash
# env.json (gitignored; copy env.json.example) — non-secret hints only
# { "cloud": { "baseUrl": "http://127.0.0.1:8080", "repoUrl": "https://github.com/acme/app.git", "repoRef": "main" } }

# .env.local (gitignored) — secrets and overrides
PIG_CLOUD_MODE=remote
PIG_CLOUD_BASE_URL=http://127.0.0.1:8080
PIG_CLOUD_TOKEN=          # optional; never put this in env.json
# optional isolated stub dir (default ./data/cloud-runs)
# PIG_CLOUD_RUNS_DIR=./data/cloud-runs
# optional repo hint if you are not using env.json / Settings
# PIG_CLOUD_REPO_URL=https://github.com/acme/app.git
# PIG_CLOUD_REPO_REF=main
```

Or Settings → 云端 → remote → paste the origin and optional repo URL/ref (or click **填入 env.json 提示**). For CI / offline smoke, `pnpm mock:cloud` speaks the four routes above (keys stay on the pig host). The workstation does not embed Firecracker, an LLM gateway, or a worker image.

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
pnpm test                 # local-stub + in-repo control stub (snapshot + follow-up)
pnpm typecheck
pnpm mock:cloud           # http://127.0.0.1:8080 — no cluster, no provider keys
```

Manual: `pnpm mock:llm`, Settings → 云端 → local-stub, send a “写一个文件” turn. Remote follow-up smoke: `pnpm mock:cloud`, Settings → remote → `http://127.0.0.1:8080`, send two messages; `data/sessions/<id>.json` keeps the same `remoteRunId`. See [MANUAL_TEST.md](../MANUAL_TEST.md).
