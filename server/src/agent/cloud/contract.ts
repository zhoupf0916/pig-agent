import type { Artifact, ChatMessage, PlanStep, SessionStatus } from "../../types.ts";

/**
 * Minimal control-plane contract (OpenAPI-ish).
 * See docs/cloud-runtime.md — this is a pig-shaped subset of neo’s Run model,
 * not a port of neo-cloud-agent.
 */

export const CLOUD_CREATE_RUN_PATH = "/v1/runs";
export const CLOUD_EVENTS_PATH = (runId: string) => `/v1/runs/${runId}/events`;
export const CLOUD_ABORT_PATH = (runId: string) => `/v1/runs/${runId}/abort`;
export const CLOUD_FOLLOW_UP_PATH = (runId: string) => `/v1/runs/${runId}/follow-ups`;

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
  | { type: "artifact" | "artifact.upserted"; artifact?: Artifact; path?: string; action?: Artifact["action"] }
  | { type: "status" | "run.started"; status?: SessionStatus }
  | { type: "error" | "run.error"; message: string }
  | { type: "done" | "run.idle"; session?: import("../../types.ts").Session };

export class CloudRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudRuntimeError";
  }
}
