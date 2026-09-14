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
};

export type SessionSummary = Pick<
  Session,
  "id" | "title" | "createdAt" | "updatedAt" | "status"
>;

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
  workspaceExists?: boolean;
  runtime: AgentRuntime;
  codexBinaryPath: string;
  codexModel: string;
  codexNetworkAccess: boolean;
  codexStatus?: CodexStatus;
  cloudBaseUrl: string;
  cloudToken: string;
  cloudMode: CloudMode;
  cloudStatus?: CloudStatus;
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
  | { type: "done"; session: Session };
