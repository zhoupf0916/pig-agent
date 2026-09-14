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
  projectId?: string;
  eventCheckpointSeq?: number;
  remoteRunId?: string;
  expertId?: string;
  expertTeamId?: string;
  teamRun?: TeamRun;
};

export type SessionSummary = Pick<
  Session,
  "id" | "title" | "createdAt" | "updatedAt" | "status" | "projectId" | "expertId" | "expertTeamId"
>;

export type ExpertKind = "scout" | "plan" | "implement" | "review" | "custom";

export type Expert = {
  id: string;
  name: string;
  description: string;
  instruction: string;
  kind: ExpertKind;
  skillIds: string[];
  bundled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExpertTeamMode = "chain" | "parallel";

export type TeamRunMemberStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type TeamRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export type TeamRunMember = {
  expertId: string;
  name: string;
  kind: ExpertKind;
  status: TeamRunMemberStatus;
  detail?: string;
};

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

export type TodoStatus = "todo" | "doing" | "done";

export type ProjectInviteStatus = "pending" | "accepted" | "declined" | "revoked";

export type ProjectMember = {
  id: string;
  userId: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
};

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
  updatedAt?: string;
  sourceSessionId?: string;
  sourceArtifactPath?: string;
};

export type ProjectMessage = {
  id: string;
  kind: "activity" | "comment" | "handoff";
  body: string;
  actorId: string;
  createdAt: string;
  sessionId?: string;
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

export type Project = {
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
  inviteToken: string;
  sessions?: SessionSummary[];
};

export type MemoryKind = "pin" | "recap";

export type MemoryNote = {
  id: string;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  sessionId?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchHitType = "session" | "project" | "todo" | "asset" | "project_message" | "memory";

export type SearchHit = {
  type: SearchHitType;
  id: string;
  title: string;
  snippet: string;
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

export type InboxItem = {
  id: string;
  kind: "invite" | "handoff";
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
  assetIds?: string[];
};

export type AssetPreviewKind = "text" | "markdown" | "json" | "image" | "binary";

export type AssetPreview = {
  asset: ProjectAsset;
  kind: AssetPreviewKind;
  content: string;
  contentBase64?: string;
  binary: boolean;
  size: number;
};

export type AgentRuntime = "pig" | "codex" | "cloud";

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: string | null;
  expertId?: string;
  expertTeamId?: string;
  projectId?: string;
  runtime: AgentRuntime;
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

export type ExecutionSurfaceKind = "pig" | "codex" | "cloud-stub" | "cloud-remote";

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
  workspaceExists?: boolean;
  runtime: AgentRuntime;
  codexBinaryPath: string;
  codexModel: string;
  codexNetworkAccess: boolean;
  codexStatus?: CodexStatus;
  cloudBaseUrl: string;
  cloudToken: string;
  cloudMode: CloudMode;
  cloudRepoUrl?: string;
  cloudRepoRef?: string;
  cloudStatus?: CloudStatus;
  executionSurface?: ExecutionSurface;
};

export type SkillMeta = {
  name: string;
  description: string;
  filename: string;
  keywords?: string[];
};

export type WorkspaceNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: WorkspaceNode[];
};

export type LiveTool = {
  id: string;
  name: string;
  arguments: unknown;
  output?: string;
  ok?: boolean;
  done: boolean;
  startedAt?: string;
  durationMs?: number;
};

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "message"; message: ChatMessage }
  | { type: "step"; step: PlanStep }
  | { type: "steps"; steps: PlanStep[] }
  | { type: "tool_start"; id: string; name: string; arguments: unknown; startedAt?: string }
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      durationMs?: number;
    }
  | { type: "artifact"; artifact: Artifact }
  | { type: "status"; status: SessionStatus }
  | { type: "error"; message: string }
  | { type: "team_run"; teamRun: TeamRun }
  | { type: "done"; session: Session };
