export type Role = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolOk?: boolean;
  toolDurationMs?: number;
  createdAt: string;
  /** Assembler-built excerpt. Never inferred from message text. */
  synthetic?: "context-compact";
};

export type PlanStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
};

export type ArtifactAction = "created" | "modified" | "deleted" | "moved";

export type Artifact = {
  /** Remote event snapshots are never paths in the host workspace. */
  source?: { kind: "remote"; runId: string; artifactId?: string };
  path: string;
  action: ArtifactAction;
  updatedAt: string;
  fromPath?: string;
  before?: string;
  after?: string;
};

export type SessionStatus = "idle" | "running" | "error";

/** How the workstation retries a failed remote turn. Default runtime stays pig. */
export type RemoteRetryKind = "follow-up" | "create-run" | "unavailable";

/** How the workstation retries a failed local pig/codex turn (Milestones M / N). */
export type LocalRetryKind = "turn" | "unavailable";

export type Session = {
  workspaceId?: string;
  workspaceName?: string;
  /** Project workspace captured when this task is created. */
  workspaceRoot?: string;
  executionTarget?: "local" | "remote";
  engine?: "pig" | "codex";
  remoteState?: import("./cloud.ts").CloudRunState;
  deliveryMode?: boolean;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messages: ChatMessage[];
  steps: PlanStep[];
  artifacts: Artifact[];
  lastError?: string;
  /** Latest model-call character estimate. Absent means not collected. */
  lastContextUsage?: import("./context.js").ContextCallSnapshot;
  /**
   * After a remote-cloud failure, how 重试 should reconnect (Milestone L).
   * `follow-up` keeps `remoteRunId`; `create-run` allocates a new run;
   * `unavailable` needs Settings / env.json before another round can work.
   */
  remoteRetry?: RemoteRetryKind;
  /**
   * After a local pig/codex failure, how 重试本轮 should behave (Milestones M / N).
   * `turn` re-runs the last user goal without inserting another message;
   * `unavailable` needs a real user goal (or Settings) before another round.
   */
  localRetry?: LocalRetryKind;
  /** Optional project this session belongs to (collaboration layer). */
  projectId?: string;
  /**
   * Last event seq persisted with this session snapshot.
   * Late joiners load the snapshot then subscribe with `after=eventCheckpointSeq`.
   */
  eventCheckpointSeq?: number;
  /**
   * Last remote control-plane run id (`runtime=cloud` + `cloudMode=remote`).
   * IDLE user turns prefer `POST /v1/runs/:id/follow-ups`.
   */
  remoteRunId?: string;
  /** Stable key for an explicit retry attempt; retained across uncertain submissions. */
  remoteRequestKey?: string;
  /** Follow-up response is uncertain; retry the same parent and idempotency key. */
  remoteFollowUpPending?: boolean;
  remoteRequireApproval?: boolean;
  /**
   * Opt in to redacted debug bodies on the next remote run of this session.
   * Omitted and false do not collect content. A new session does not copy it.
   * Follow-ups send it only while it is still true.
   */
  remoteDebugContent?: boolean;
  /** Optional local expert / playbook pinned to this session. */
  expertId?: string;
  /** Skills chosen for this task. Unknown ids are rejected at creation. */
  skillIds?: string[];
  /** Frozen skill instructions and pack files. Later library edits do not change this. */
  skillSnapshots?: import("./skill-pack.js").SkillSnapshot[];
  /** Optional expert-team metadata (chain/parallel). Instruction comes from expertId, or the whole team if unset. */
  expertTeamId?: string;
  /**
   * Sequential chain progress (Milestone I). Same-session pig turns — not handoff-per-step.
   * Present when a chain team run has been started on this session.
   */
  teamRun?: TeamRun;
};

export type SessionSummary = Pick<
  Session,
  | "id"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "status"
  | "workspaceId"
  | "workspaceRoot"
  | "workspaceName"
  | "projectId"
  | "expertId"
  | "expertTeamId"
>;

export type ExpertKind = "scout" | "plan" | "implement" | "review" | "custom";

export type Expert = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  kind: ExpertKind;
  /** Local `skills/` names this playbook prefers. Not a marketplace. */
  skillIds: string[];
  bundled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExpertTeamMode = "chain" | "parallel";

/** Per-member status inside a sequential team run. */
export type TeamRunMemberStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type TeamRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export type TeamRunMember = {
  expertId: string;
  name: string;
  kind: ExpertKind;
  status: TeamRunMemberStatus;
  detail?: string;
};

/**
 * Same-session sequential pipeline. Child session ids are unused in Milestone I
 * (`strategy` is always `"same-session"`).
 */
export type TeamRun = {
  teamId: string;
  teamName: string;
  strategy: "same-session";
  status: TeamRunStatus;
  currentIndex: number;
  members: TeamRunMember[];
  startedAt: string;
  updatedAt: string;
};

export type ExpertTeam = {
  id: string;
  name: string;
  description: string;
  mode: ExpertTeamMode;
  expertIds: string[];
  bundled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BoundPlaybook = {
  expertInstruction?: string;
  projectInstruction?: string;
  preferredSkillIds?: string[];
};

export type ProjectRole = "owner" | "admin" | "member";

export type ProjectInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked";

export type ProjectMember = {
  id: string;
  userId: string;
  displayName: string;
  role: ProjectRole;
  joinedAt: string;
};

/** Lightweight named invite on a single Pig host (not cloud SSO). */
export type ProjectInvite = {
  id: string;
  token: string;
  displayName: string;
  note?: string;
  invitedByUserId: string;
  invitedByName: string;
  status: ProjectInviteStatus;
  createdAt: string;
  resolvedAt?: string;
  memberId?: string;
};

export type TodoStatus = "todo" | "doing" | "done";

export type ProjectTodo = {
  id: string;
  title: string;
  status: TodoStatus;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectAsset = {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: string;
  /** Set when the file was last overwritten (e.g. re-save from a session artifact). */
  updatedAt?: string;
  /** Session that last copied this file into the project. */
  sourceSessionId?: string;
  /** Workspace-relative artifact path; identity key for idempotent overwrite. */
  sourceArtifactPath?: string;
};

export type ProjectMessageKind = "activity" | "comment" | "handoff";

export type ProjectMessage = {
  id: string;
  kind: ProjectMessageKind;
  body: string;
  actorId: string;
  createdAt: string;
  sessionId?: string;
};

export type ProjectWorkspace = { id: string; name: string; path: string; createdAt: string };

export type Project = {
  workspaces?: ProjectWorkspace[];
  defaultWorkspaceId?: string;
  workspaceRoot?: string;
  effectiveWorkspaceRoot?: string;
  id: string;
  name: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  members: ProjectMember[];
  invites: ProjectInvite[];
  todos: ProjectTodo[];
  assets: ProjectAsset[];
  messages: ProjectMessage[];
  /** Latest generated invite token (compat + copy from the project page). */
  inviteToken: string;
};

export type ProjectSummary = {
  workspaces?: ProjectWorkspace[];
  defaultWorkspaceId?: string;
  workspaceRoot?: string;
  id: string;
  name: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  todoCount: number;
  assetCount: number;
  sessionCount: number;
};

export type MemoryKind = "pin" | "recap";

/**
 * Writable local memory note (Milestone H). JSON under `data/memory/`.
 * Pins are user-curated facts; recaps are short turn summaries.
 */
export type MemoryNote = {
  id: string;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  sessionId?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  source?: "user" | "recap";
  scope?: "personal" | "session" | "project";
  stability?: "stable" | "volatile";
  expiresAt?: string;
  revokedAt?: string;
};

export type SearchHitType =
  | "session"
  | "project"
  | "todo"
  | "asset"
  | "project_message"
  | "memory";

/** Read-only local search hit (Milestone G). No embeddings. */
export type SearchHit = {
  type: SearchHitType;
  id: string;
  title: string;
  snippet: string;
  /** Hash route, e.g. `#/sessions/<id>` or `#/projects/<id>?asset=<id>`. */
  href: string;
  sessionId?: string;
  projectId?: string;
  assetId?: string;
  todoId?: string;
  messageId?: string;
};

export type SearchResponse = {
  q: string;
  limit: number;
  hits: SearchHit[];
};

export type InboxKind = "invite" | "handoff";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  projectId: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  inviteToken?: string;
  inviteId?: string;
  inviteStatus?: ProjectInviteStatus;
  projectName?: string;
  inviterName?: string;
  inviteeName?: string;
  inviteNote?: string;
  sessionId?: string;
  /** Project assets attached when this handoff was created. */
  assetIds?: string[];
};

export type AssetPreviewKind =
  | "text"
  | "markdown"
  | "json"
  | "image"
  | "binary";

export type AssetPreview = {
  asset: ProjectAsset;
  kind: AssetPreviewKind;
  content: string;
  contentBase64?: string;
  binary: boolean;
  size: number;
};

export type AgentRuntime = "pig" | "codex" | "cloud";

/**
 * Local automation (Milestone D). JSON under `data/automations/`.
 * No public webhooks / remote workers — in-process cron or manual Run now.
 */
export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  /** 5-field cron, `@hourly`, `@daily`, or null for manual-only. */
  schedule: string | null;
  expertId?: string;
  expertTeamId?: string;
  /** Skill names captured when the automation is saved and passed into each run. */
  skillIds?: string[];
  projectId?: string;
  /** Default pig. Stored per automation; does not change global settings. */
  runtime: AgentRuntime;
  executionTarget?: "local" | "remote";
  engine?: "pig" | "codex";
  timezone?: string;
  misfirePolicy?: "skip" | "once";
  nextFireAt?: string;
  lastRemoteRunId?: string;
  /** Local migration tombstone; remote schedule is authoritative after transfer. */
  remoteScheduleId?: string;
  /**
   * After a successful run, copy new session artifacts into the bound project.
   * Default false — opt-in so scheduled jobs do not silently fill assets.
   */
  saveArtifactsToProject?: boolean;
  lastRunAt?: string;
  lastSessionId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudMode = "local-stub" | "remote";

export type CodexStatus = {
  binaryFound: boolean;
  homeWritable: boolean;
  apiKeyPresent: boolean;
};

export type CloudHintSource = "settings" | "env.json" | "env";

export type CloudEnvJsonStatus = {
  found: boolean;
  file: "env.json";
  baseUrl?: string;
  repoUrl?: string;
  repoRef?: string;
};

export type CloudRepoHintStatus = {
  repoUrl?: string;
  ref?: string;
  repoUrlSource?: CloudHintSource;
  refSource?: CloudHintSource;
};

export type CloudInstallHints = {
  install?: string;
  deps?: string[];
  tools?: string[];
  setup?: string[];
};

export type CloudStatus = {
  mode: CloudMode;
  remoteUrlConfigured: boolean;
  tokenPresent: boolean;
  envJson?: CloudEnvJsonStatus;
  repoHint?: CloudRepoHintStatus;
  effectiveBaseUrl?: string;
  installHints?: CloudInstallHints;
  installHintsFile?: string;
};

export type ExecutionSurfaceKind =
  | "pig"
  | "codex"
  | "cloud-stub"
  | "cloud-remote";

/** At-a-glance execution surface for topbar / Settings. Default is pig. */
export type ExecutionSurface = {
  runtime: AgentRuntime;
  kind: ExecutionSurfaceKind;
  mode?: CloudMode;
  label: string;
  detail: string;
  summary: string;
};

export type Settings = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  workspaceRoot: string;
  /** Default pig loop. `codex` and `cloud` are optional opt-in backends. */
  runtime: AgentRuntime;
  /** Empty = look up `codex` on PATH (or `CODEX_BIN`). */
  codexBinaryPath: string;
  /** Independent Responses provider; never implicitly uses Pig credentials. */
  codexApiKey?: string;
  codexBaseUrl?: string;
  /** Codex model slug, e.g. deepseek-flash. Not the pig Chat Completions model. */
  codexModel: string;
  /**
   * Outbound network inside Codex workspace-write sandbox.
   * Default false; must be an explicit opt-in.
   */
  codexNetworkAccess: boolean;
  /**
   * Remote control-plane origin (no `/v1` suffix). Empty in local-stub mode.
   * Provider keys must not be sent to workers — this URL is the host control path.
   */
  cloudBaseUrl: string;
  /** Optional bearer token for the control plane. Never commit; store in env / data/. */
  cloudToken: string;
  /** Default `local-stub` so CI and `pnpm test` need no cluster. */
  cloudMode: CloudMode;
  /**
   * Optional remote clone hint. Empty falls through to env.json then PIG_CLOUD_REPO_URL.
   * Non-secret; never put tokens here.
   */
  cloudRepoUrl?: string;
  /** Optional git ref for the clone hint. Empty falls through to env.json then PIG_CLOUD_REPO_REF. */
  cloudRepoRef?: string;
};

export type SkillMeta = {
  name: string;
  description: string;
  filename: string;
  displayName?: string;
  keywords?: string[];
  filePaths?: string[];
};

export type Skill = SkillMeta & {
  body: string;
  allowedTools?: string[];
  /** Spec name when the lookup id is a plugin or cloud entity id. */
  machineName?: string;
  files?: import("./skill-pack.js").SkillPackFile[];
};

export type WorkspaceNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: WorkspaceNode[];
};

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "message"; message: ChatMessage }
  | { type: "step"; step: PlanStep }
  | { type: "steps"; steps: PlanStep[] }
  | {
      type: "tool_start";
      id: string;
      name: string;
      arguments: unknown;
      startedAt: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      durationMs: number;
    }
  | { type: "artifact"; artifact: Artifact }
  | { type: "status"; status: SessionStatus }
  | { type: "error"; message: string }
  | { type: "context_usage"; usage: import("./context.js").ContextCallSnapshot }
  | { type: "team_run"; teamRun: TeamRun }
  | { type: "done"; session: Session }
  /**
   * Transient SSE-only catch-up marker (Milestone O). Never written to events.jsonl.
   * `after` is the exclusive reconnect cursor; `gap` is how many persisted events follow.
   */
  | {
      type: "sync";
      phase: "catching_up" | "live";
      after: number;
      lastSeq: number;
      gap: number;
    };

export type SessionEventRecord = {
  seq: number;
  ts: string;
  event: AgentEvent;
};

export type PublicSettings = Settings & {
  workspaceExists?: boolean;
  codexStatus?: CodexStatus;
  cloudStatus?: CloudStatus;
  executionSurface?: ExecutionSurface;
  llmApiKeyConfigured?: boolean;
  codexApiKeyConfigured?: boolean;
  cloudTokenConfigured?: boolean;
};
export type ProjectDetail = Project & { sessions?: SessionSummary[] };

export { BUNDLED_EXPERTS, BUNDLED_TEAMS, BUNDLED_SCOUT_ID, BUNDLED_PLAN_ID, BUNDLED_IMPLEMENT_ID, BUNDLED_REVIEW_ID, BUNDLED_CODING_TEAM_ID } from "./bundled-experts.js";
export { planToCron, cronToPlan, describePlan, localLeaseDecision, SchedulePlanError } from "./schedule-plan.js";
export type { SchedulePlan } from "./schedule-plan.js";
export { isBlockedEgressAddress, isLoopbackAddress, isMetadataAddress, expandIp, isPrivateIPv4Address } from "./egress.js";
export { ECOSYSTEM_CATALOG, catalogPlugin } from "./ecosystem-catalog.js";
export type { EcosystemPlugin, EcosystemSkill, EcosystemExpert, McpServerView, McpToolView, McpExecutionTarget } from "./ecosystem.js";
export { MCP_TOOL_PREFIX, mcpToolName, parseMcpToolName, exposedMcpToolName, redactConfiguredSecret, redactSecretValue, mcpDefinitions } from "./ecosystem.js";
export { presentDebugTrace, closeTerminalDebugTrace } from "./debug-trace.js";
export type { DebugSpan, DebugSpanKind, DebugSpanStatus, DebugTraceView } from "./debug-trace.js";
export type { PluginManifest, InstalledPlugin } from "./plugins.js";
export {
  validateSkillName,
  validateSkillPackFiles,
  validateSkillRelativePath,
  parseSkillFrontmatter,
  skillActivationPrompt,
  skillContentDigest,
  skillMaterialPrefix,
  validateSkillUpload,
  SKILL_PACK_LIMITS,
} from "./skill-pack.js";
export type { SkillPackFile, SkillSnapshot } from "./skill-pack.js";
export { workspaceFileRevision, decideFileEdit, workspaceEditPathError } from "./workspace-file.js";
export {
  CONTEXT_COMPACT_ID,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  ContextBudgetExceededError,
  assembleModelContext,
  contextUsageFromMetrics,
  presentContextUsage,
  unknownContextUsage,
  continuationTranscript,
  durableMessages,
  authoritativeTranscript,
  boundedFollowUpInput,
  followUpModelInput,
  isContextCompact,
  recallTranscript,
  readContextEvidence,
  selectInjectableMemory,
} from "./context.js";
export type { ContextEvidence, AssembledContext, ContextCallSnapshot, ContextMetrics, MemoryCandidate } from "./context.js";
export type { WorkspaceFileEdit, WorkspaceFileVersion } from "./workspace-file.js";

export { summarizeRunTiming } from "./debug-trace.js";
export type { RunTimingSummary } from "./debug-trace.js";
