import { presentContextUsage } from "@pig-agent/contracts";
import type { AgentEvent, Artifact, ChatMessage, PlanStep, SessionStatus } from "../../types.ts";
import { newId, nowIso } from "../../util.ts";

const STATUS: SessionStatus[] = ["idle", "running", "error"];

export function parseCloudSseData(data: string): unknown | undefined {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Map a control-plane SSE payload onto pig AgentEvents.
 * Unknown types are dropped so a richer future plane cannot break the workstation UI.
 */
export function mapCloudEvent(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const ev = raw as Record<string, unknown>;
  const type = String(ev.type ?? ev.event ?? "");

  if (type === "token" || type === "assistant.delta") {
    return typeof ev.text === "string" && ev.text ? [{ type: "token", text: ev.text }] : [];
  }

  if (type === "message") {
    const message = asMessage(ev.message ?? ev);
    return message ? [{ type: "message", message }] : [];
  }

  if (type === "assistant.message") {
    const content = typeof ev.content === "string" ? ev.content : "";
    if (!content) return [];
    return [
      {
        type: "message",
        message: {
          id: typeof ev.id === "string" ? ev.id : newId("msg"),
          role: "assistant",
          content,
          createdAt: typeof ev.createdAt === "string" ? ev.createdAt : nowIso(),
        },
      },
    ];
  }

  if (type === "tool_start" || type === "tool.started" || type === "tool.start") {
    const id = typeof ev.id === "string" ? ev.id : "";
    const name = typeof ev.name === "string" ? ev.name : "";
    if (!id || !name) return [];
    return [
      {
        type: "tool_start",
        id,
        name,
        arguments: ev.arguments,
        startedAt: typeof ev.startedAt === "string" ? ev.startedAt : nowIso(),
      },
    ];
  }

  if (type === "tool_end" || type === "tool.finished" || type === "tool.end") {
    const id = typeof ev.id === "string" ? ev.id : "";
    const name = typeof ev.name === "string" ? ev.name : "";
    if (!id || !name) return [];
    return [
      {
        type: "tool_end",
        id,
        name,
        ok: ev.ok !== false,
        output: typeof ev.output === "string" ? ev.output : "",
        durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
      },
    ];
  }

  if (type === "steps" || type === "plan.updated") {
    const steps = asSteps(ev.steps);
    return steps ? [{ type: "steps", steps }] : [];
  }

  if (type === "step") {
    const step = asStep(ev.step);
    return step ? [{ type: "step", step }] : [];
  }

  if (type === "artifact" || type === "artifact.upserted") {
    const artifact = asArtifact(ev.artifact) ?? asArtifact(ev);
    return artifact ? [{ type: "artifact", artifact }] : [];
  }

  if (type === "run.started") {
    return [{ type: "status", status: "running" }];
  }

  if (type === "status") {
    const status = STATUS.includes(ev.status as SessionStatus)
      ? (ev.status as SessionStatus)
      : undefined;
    return status ? [{ type: "status", status }] : [];
  }

  if (type === "context_usage") {
    const usage = presentContextUsage(ev.usage);
    return usage ? [{ type: "context_usage", usage }] : [];
  }

  if (type === "error" || type === "run.error") {
    const message = typeof ev.message === "string" ? ev.message : "Cloud run failed";
    return [{ type: "error", message }];
  }

  if (type === "done") {
    if (ev.session && typeof ev.session === "object") {
      return [{ type: "done", session: ev.session as import("../../types.ts").Session }];
    }
    return [{ type: "status", status: "idle" }];
  }

  if (type === "run.idle") {
    return [{ type: "status", status: "idle" }];
  }

  return [];
}

function asMessage(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool" && m.role !== "system") {
    return undefined;
  }
  return {
    id: typeof m.id === "string" ? m.id : newId("msg"),
    role: m.role,
    content: typeof m.content === "string" ? m.content : "",
    toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as ChatMessage["toolCalls"]) : undefined,
    toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : undefined,
    toolOk: typeof m.toolOk === "boolean" ? m.toolOk : undefined,
    toolDurationMs: typeof m.toolDurationMs === "number" ? m.toolDurationMs : undefined,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : nowIso(),
  };
}

function asSteps(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item, i) => asStep(item) ?? { id: newId("step"), title: `Step ${i + 1}`, status: "pending" });
}

function asStep(raw: unknown): PlanStep | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const status = s.status;
  return {
    id: typeof s.id === "string" ? s.id : newId("step"),
    title: typeof s.title === "string" ? s.title : "Step",
    status:
      status === "running" || status === "done" || status === "error" || status === "pending"
        ? status
        : "pending",
    detail: typeof s.detail === "string" ? s.detail : undefined,
  };
}

function asArtifact(raw: unknown): Artifact | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.path !== "string" || !a.path) return undefined;
  const action = a.action;
  return {
    path: a.path,
    action:
      action === "created" || action === "modified" || action === "deleted" || action === "moved"
        ? action
        : "modified",
    updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : nowIso(),
    fromPath: typeof a.fromPath === "string" ? a.fromPath : undefined,
    before: typeof a.before === "string" ? a.before : undefined,
    after: typeof a.after === "string" ? a.after : undefined,
  };
}
