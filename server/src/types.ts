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
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolOk?: boolean;
  toolDurationMs?: number;
  createdAt: string;
};

export type PlanStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
};

export type ArtifactAction = "created" | "modified" | "deleted" | "moved";

export type Artifact = {
  path: string;
  action: ArtifactAction;
  updatedAt: string;
  fromPath?: string;
  before?: string;
  after?: string;
};

export type SessionStatus = "idle" | "running" | "error";

export type Session = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messages: ChatMessage[];
  steps: PlanStep[];
  artifacts: Artifact[];
  lastError?: string;
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
};

export type SessionSummary = Pick<
  Session,
  "id" | "title" | "createdAt" | "updatedAt" | "status" | "projectId"
>;

export type ProjectRole = "owner" | "admin" | "member";

export type ProjectMember = {
  id: string;
  userId: string;
  displayName: string;
  role: ProjectRole;
  joinedAt: string;
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

export type Project = {
  id: string;
  name: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  members: ProjectMember[];
  todos: ProjectTodo[];
  assets: ProjectAsset[];
  messages: ProjectMessage[];
  inviteToken: string;
};

export type ProjectSummary = {
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
  sessionId?: string;
};

export const LOCAL_USER_ID = "user_local";
export const LOCAL_USER_NAME = "本机用户";

export type AgentRuntime = "pig" | "codex" | "cloud";

export type CloudMode = "local-stub" | "remote";

export type CodexStatus = {
  binaryFound: boolean;
  homeWritable: boolean;
  apiKeyPresent: boolean;
};

export type CloudStatus = {
  mode: CloudMode;
  remoteUrlConfigured: boolean;
  tokenPresent: boolean;
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
};

export type SkillMeta = {
  name: string;
  description: string;
  filename: string;
  keywords?: string[];
};

export type Skill = SkillMeta & {
  body: string;
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
  | { type: "tool_start"; id: string; name: string; arguments: unknown; startedAt: string }
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
  | { type: "done"; session: Session };

export type SessionEventRecord = {
  seq: number;
  ts: string;
  event: AgentEvent;
};

/** Shared options passed to pig / codex / cloud runners. */
export type AgentRunOptions = {
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Project instruction, injected into the system prompt when bound. */
  projectInstruction?: string;
};
