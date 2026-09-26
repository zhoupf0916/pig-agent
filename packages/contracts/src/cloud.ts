import type {
  Artifact,
  ChatMessage,
  PlanStep,
  SessionStatus,
} from "./index.ts";
import type { ContextCallSnapshot } from "./context.js";

/** Display metadata survives refresh without exposing tool arguments in stored transcripts. */
export type CloudConversationMessage = Pick<ChatMessage, "id" | "role" | "content"> & {
  createdAt?: string;
  author?: { id: string; name: string };
  /** Present on live assistant messages; stored display transcripts omit these. */
  toolCalls?: ChatMessage["toolCalls"];
  phase?: "progress" | "answer";
  outcome?: "running" | "approval" | "failed" | "cancelled";
  notice?: string;
};

/**
 * Minimal control-plane contract (OpenAPI-ish).
 * See docs/cloud-runtime.md — this is a pig-shaped subset of neo’s Run model,
 * not a port of neo-cloud-agent.
 */

export const CLOUD_CREATE_RUN_PATH = "/v1/runs";
export const CLOUD_EVENTS_PATH = (runId: string) => `/v1/runs/${runId}/events`;
export const CLOUD_ABORT_PATH = (runId: string) => `/v1/runs/${runId}/abort`;
export const CLOUD_FOLLOW_UP_PATH = (runId: string) =>
  `/v1/runs/${runId}/follow-ups`;

/** Account-owned memory metadata exposed by GET /v1/memory; no model credentials. */
export type CloudMemoryRecord = {
  id: string;
  content: string;
  created_at: string;
  updated_at?: string;
  source?: "user" | "recap" | "agent";
  scope?: "personal" | "project" | "session";
  stability?: "stable" | "volatile";
  expires_at?: string | null;
  revoked_at?: string | null;
};

/** Non-secret worker/local prep hints. Never include API keys or .env values. */
export type CloudInstallHints = {
  install?: string;
  deps?: string[];
  tools?: string[];
  setup?: string[];
};

export type CloudWorkspaceHandoff = {
  snapshot?: {
    encoding: "tar.gz";
    data: string;
    files: string[];
    skipped: string[];
    byteSize: number;
    truncated?: boolean;
  };
  repoUrl?: string;
  ref?: string;
  /** Sanitized environment.json-style install hints for the plane / worker prep. */
  installHints?: CloudInstallHints;
};

export type CloudCreateRunRequest = {
  requireApproval?: boolean;
  /**
   * Opt in to storing redacted model and tool bodies on this run's debug trace.
   * Omitted and false do not collect that content.
   */
  debugContent?: boolean;
  prompt: string;
  sessionId: string;
  messages: Array<Pick<ChatMessage, "id" | "role" | "content" | "createdAt">>;
  model?: string;
  /** First turn only. Follow-ups reuse the worker workspace. */
  workspace?: CloudWorkspaceHandoff;
};

export type CloudCreateRunResponse = {
  id: string;
  status?: "queued" | "running";
};

export type CloudFollowUpRequest = {
  prompt: string;
  /** Same opt-in as CloudCreateRunRequest.debugContent. Omitted does not inherit a previous run. */
  debugContent?: boolean;
};

export type CloudFollowUpResponse = {
  ok: boolean;
  id?: string;
  status?: "queued" | "running" | "idle" | "expired";
};

export type CloudAbortResponse = {
  ok: boolean;
};

/**
 * Inbound SSE JSON. Either a pig `AgentEvent` or a thin neo-inspired alias.
 * Provider keys must never appear in these payloads.
 */
export type CloudInboundEvent =
  | { type: "token"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "message"; message: ChatMessage }
  | { type: "assistant.message"; content: string; id?: string }
  | {
      type: "tool_start" | "tool.started" | "tool.start";
      id: string;
      name: string;
      arguments?: unknown;
      startedAt?: string;
    }
  | {
      type: "tool_end" | "tool.finished" | "tool.end";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      durationMs?: number;
    }
  | { type: "steps" | "plan.updated"; steps: PlanStep[] }
  | { type: "step"; step: PlanStep }
  | {
      type: "artifact" | "artifact.upserted";
      artifact?: Artifact;
      path?: string;
      action?: Artifact["action"];
    }
  | { type: "status" | "run.started"; status?: SessionStatus }
  | { type: "error" | "run.error"; message: string }
  | { type: "done" | "run.idle"; session?: import("./index.ts").Session }
  | { type: "context_usage"; usage: ContextCallSnapshot };

export type CloudRemoteErrorCode =
  | "missing_url"
  | "invalid_url"
  | "snapshot_failed"
  | "control_plane_timeout"
  | "create_run_failed"
  | "subscribe_failed"
  | "no_run_id"
  | "secrets_refused"
  | "run_expired"
  | "disconnected"
  | "generic";

export class CloudRuntimeError extends Error {
  readonly code: CloudRemoteErrorCode;
  constructor(message: string, code: CloudRemoteErrorCode = "generic") {
    super(message);
    this.name = "CloudRuntimeError";
    this.code = code;
  }
}

/** Local control-plane v1 API; distinct from the workstation's session status. */
export type CloudRunState =
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";
export type CloudRunSummary = {
  id: string;
  state: CloudRunState;
  prompt: string;
  owner_id?: string;
  project_id?: string;
  can_write?: boolean;
  require_approval?: boolean;
  conversation_id?: string;
  parent_run_id?: string;
  error?: string;
  created_at: string;
  updated_at?: string;
  model_calls: number;
};
export type CloudArtifactSummary = { id: string; path: string; size: number };

export type CloudSpace = {
  id: string;
  name: string;
  owner_id: string;
  role: "viewer" | "editor" | "admin";
};
export type CloudSharedProject = {
  id: string;
  space_id: string;
  name: string;
  description: string;
  space_name: string;
  role: CloudSpace["role"];
};

export type McpApprovalTarget = { serverId: string; serverName: string; url: string; credentialVersion: number };
export type CloudApproval = {mcp_target?: McpApprovalTarget | null;id:string;call_id:string;tool:string;args:Record<string,unknown>;state:"pending"|"approved"|"rejected"|"consumed"|"expired";created_at:string;decided_at?:string;decided_by?:string};

export type CloudProject = CloudSharedProject & {
  kind: "personal" | "collaborative";
  workspace_name: string;
};
export type CloudProjectWorkspace = {
  projectId: string;
  workspaceName: string;
  seed?: { fileCount: number; byteSize: number; files: string[] };
  conversations: Array<{ id: string; title: string; versions: Array<{ run_id: string; created_at: string; manifest: { files?: string[] } }> }>;
};

/** Platform CNY tariff; amounts use integer millionths of one yuan. */
export interface ModelTariff { input: number; cached: number; output: number }
export interface ModelTokenUsage { input: number; cached: number; output: number }
export interface AccountBudget {
  budget_micros: string | number;
  spent_micros: string | number;
  reserved_micros: string | number;
  daily_call_limit: number;
  calls_today: string | number;
}

/** Recoverable only at a completed tool-group boundary; never an authorization receipt. */
export type RunCheckpoint = {
  messages: import("./index.ts").ChatMessage[];
  snapshot: { encoding: "tar.gz"; data: string; files: string[]; skipped: string[]; byteSize: number; truncated?: boolean };
};
