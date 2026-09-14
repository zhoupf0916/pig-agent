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
  createdAt: string;
};

export type PlanStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
};

export type Artifact = {
  path: string;
  action: "created" | "modified";
  updatedAt: string;
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

export type Settings = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  workspaceRoot: string;
};

export type SkillMeta = {
  name: string;
  description: string;
  filename: string;
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
  | { type: "tool_start"; id: string; name: string; arguments: unknown }
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      output: string;
    }
  | { type: "artifact"; artifact: Artifact }
  | { type: "status"; status: SessionStatus }
  | { type: "error"; message: string }
  | { type: "done"; session: Session };
