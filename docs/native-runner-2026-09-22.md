# Native task sandbox migration (2026-09-22)

## Decision and boundaries

Docker continues to deploy PostgreSQL, control planes, gateway and long-lived Runner services. A task no longer creates a Docker container/network or needs Docker socket access. Each Runner launches a trusted per-job Node agent process in a private temporary directory; shell tools enter Bubblewrap user/mount/PID/network namespaces with a seccomp filter. File tools and workspace preview/export/handoff enter a separately bundled helper under the same OS boundary, retaining canonical path checks as defense in depth. Model credentials stay in the gateway; the per-attempt capability is held by the trusted agent and never included in shell environment or sandbox mounts. Approved HTTP requests use the existing authenticated gateway. Direct shell networking remains blocked.

This is shared-kernel process isolation, not a microVM and not equivalent to Cursor managed cloud's Firecracker isolation. Cursor self-hosted architecture is used as a separation-of-responsibility reference, not a claim of implementation equivalence.

## Runner container requirements

Actual Docker Desktop ARM64 probing showed default Docker seccomp denies creating user namespaces. The Runner uses the upstream Moby default seccomp profile plus explicit allowances for `clone`, `clone3`, `unshare`, `mount`, `umount2`, `pivot_root`, and `setns`. `systempaths=unconfined` is also required so Bubblewrap can mount a fresh `/proc` in its child PID namespace. This relaxes the outer service boundary; tools receive an inner seccomp filter and an allowlisted filesystem with their own `/proc`. Runner runs UID 1000, drops all Linux capabilities, sets no-new-privileges, and does not use privileged mode or host filesystem/socket mounts. Unsupported hosts fail preflight before claiming work; there is no host-execution fallback.

The JSON profile source is https://github.com/moby/profiles/blob/main/seccomp/default.json (retrieved 2026-09-22). A short-lived offline storage-init service migrates the existing named outbox volume ownership to UID 1000. It has only CHOWN/DAC_READ_SEARCH and exits before Worker starts.

## Retained execution semantics

Control-plane leases, attempt-token fencing, claim concurrency, bounded graceful drain, cancellation, event ordering and durable completion outbox remain authoritative. Runner restarts remove its container-private temporary job directories; crash-interrupted tasks are failed rather than automatically replaying unknown side effects. No exactly-once execution guarantee is claimed.

Human approval pauses execution budget for at most 30 minutes. Control-plane deadline remains authoritative, heartbeats still expire on loss of ownership, and cancellation remains live during approval. The trusted agent separately pauses its execution timer. A decision restores the remaining execution budget.

## Resource limitation

The deployment has a hard aggregate Runner cgroup limit of 4 GiB and 1024 processes. Per-task memory/PID/CPU observation samples `/proc` every 500 ms and terminates over-budget process trees; these are sampled guards, not per-task cgroup guarantees. The profile's CPU value is not an enforced CPU share. Short-lived process bursts and CPU between samples are not accounted exactly. Dedicated cgroup delegation or VM allocation is required for strict per-tenant resource accounting. This limitation must remain visible in deployment documentation and must not be marketed as production multitenant hard quotas.

## Verification

The local two-control/two-Runner results and final deployment evidence are recorded below.

### Actual results

- Native sandbox probe inside deployed ARM64 Runner: Node v24.21.0, Git 2.39.5, Python 3.11.2 execute; task workspace write succeeds; neighbor workspace and `/app` are not mounted; Worker/attempt credentials absent from tool environment; direct TCP connection blocked. Evidence: `docs/evidence/native-runner-2026-09-22/isolation.json`.
- `node scripts/smoke-cluster-runners.mjs`: passed in 66.8 seconds against two real controls and two real Runners with a mock model. Four concurrent jobs used four native processes and zero task containers. Verified queued progress, SIGKILL lease expiration without replay, task completion after one control stops, cancellation on survivor, bounded SIGTERM drain and cleanup. Evidence: `docs/evidence/native-runner-2026-09-22/runners.json`.
- `node scripts/smoke-cluster-control.mjs`: 14 scenarios passed, including competing claim, idempotency, global/user/Runner/project limits, draining, stale operation fencing, approval receipt replay defense, queue expiry, authoritative deadline and two schedulers.
- Targeted execution-budget / worker unit suite: 16 tests passed. Server and Worker TypeScript checks passed during this change; final repository-wide validation is tracked by the integration owner.

Reproduce with `pnpm cloud:build && node scripts/cluster-local.mjs up`, then `node scripts/smoke-cluster-control.mjs` and `node scripts/smoke-cluster-runners.mjs`. The Runner smoke intentionally stops and restarts test cluster nodes; do not point it at a production deployment. Cluster fault injection was restricted to port 8892. Final integration subsequently backed up and updated port 8890; see docs/native-productization-worklog.md.

### Cross-review corrections

Before final integration, native sandbox creation now rejects filesystem/system roots, the whole home directory and shared temporary roots as a workspace. Seccomp rejects namespace flags to legacy `clone`, new mount APIs and io_uring; normal fork and thread creation remain available. Six policy/real macOS tests passed and the Linux Node/Git/Python/network probe was repeated with the tightened filter. A real Linux `fork` + `setsid` background writer stopped when the Bubblewrap process group was killed; its counter remained 10 after a further 400ms.

Historical cross-review finding (fixed below): file-tool operations at that stage executed in the trusted Agent with canonical path guards. A concurrent directory/symlink replacement can race those checks; canonical checks alone are not a kernel-enforced filesystem boundary. macOS Seatbelt descendants retain filesystem/network restrictions, but process-group cancellation alone cannot guarantee termination of deliberately detached descendants the way Linux PID namespaces do. Neither property is claimed solved by the policy tightening above.

### File-tool boundary closed before final delivery

The residual file-tool path-check race identified above was subsequently fixed structurally: all eight model-facing file tools, approval preview/capture, pre/post approval verification, undo restoration and direct upload restoration now execute in a separately bundled trusted helper inside the same native OS sandbox when native mode is selected. JSON enters over stdin; only output and artifact receipts return. The helper receives no provider/worker/session credentials. The helper bundle and executable are explicitly read-only mounts; no full `/app` mount is added. Explicit host mode keeps host semantics. Model-facing definitions do not expose internal capture/restore commands.

`pnpm build`, `pnpm test`, server dev/start, cloud and desktop builds create the helper; a missing helper fails closed. Linux dev/CI hosts need Bubblewrap with user namespaces enabled. macOS Node and the actual Electron executable both passed native file write/read and outside-symlink rejection. Linux Runner passed the same helper probe via a temporary test bundle without restarting services. Dangling final symlinks now fail validation. Relevant workbench/file/policy/sandbox regression suite: 27 passed, including binary move/delete undo and sequential approval.

### Remaining preview/handoff race reproduced and fixed

A real macOS native-sandbox attacker repeatedly replaced a workspace subdirectory with a symlink to a sibling **synthetic canary** directory. The former host-path implementation leaked the canary 2 times in 1000 preview attempts. This confirmed a real boundary issue, not just a theoretical warning.

Workspace tree/preview, local artifact binary export and the production remote handoff (including installation hints and snapshot packing) now use the same helper boundary. The patched race experiment performed 36 requests across preview, binary read and handoff (checking decompressed archives): 15 safe responses, 21 blocked races, zero canary leaks; the canary remained unchanged. Script: `pnpm exec tsx scripts/security/native-helper-race.ts` after `node scripts/build-native-helper.mjs`. The script toggles a helper-internal flag only in its own synthetic baseline process, never in a running server. Counts vary with scheduling; it asserts no patched leaks.

Remote cancellation now checks the abort signal after sandboxed snapshot preparation and before marking a submission as sent. The existing mid-stream cancellation test waits for the actual stream request, rather than assuming snapshot preparation finishes within 50ms. Related artifact/remote/helper regression: 27 passed. Non-tool application-private project asset storage is not exposed to sandbox workspaces by default; its normal trusted storage path remains unchanged.
