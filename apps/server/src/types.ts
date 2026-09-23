export type * from "@pig-agent/contracts";
import type { Session, Settings, AgentEvent } from "@pig-agent/contracts";

/** Shared options passed to pig / codex / cloud runners. */
export type AgentRunOptions = {
  onRunCreated?: (runId: string) => Promise<void>;
  session: Session;
  settings: Settings;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Project instruction, injected into the system prompt when bound. */
  projectInstruction?: string;
  /** Expert / playbook instruction. Precedes project when both are set. */
  expertInstruction?: string;
  /** Extra local skill names to preload (from the pinned expert). */
  preferredSkillIds?: string[];
  mcpTools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>;
  mcpInvoke?: (call: { name: string; args: Record<string, unknown>; signal: AbortSignal; callId: string }) => Promise<string>;
};

export const LOCAL_USER_ID = "user_local";
export const LOCAL_USER_NAME = "本机用户";
