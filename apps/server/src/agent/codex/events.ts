import type { ArtifactAction } from "../../types.ts";

export type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  tool?: string;
  server?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  message?: string;
};

export type CodexJsonlEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string } | string;
  message?: string;
};

export type CodexMapped =
  | { kind: "ignore" }
  | { kind: "status"; status: "running" | "idle" | "error" }
  | { kind: "tool_start"; id: string; name: string; arguments: unknown }
  | { kind: "tool_end"; id: string; name: string; ok: boolean; output: string }
  | { kind: "assistant"; content: string }
  | { kind: "artifact"; path: string; action: ArtifactAction }
  | { kind: "error"; message: string }
  | { kind: "turn_done" };

const TRANSIENT_ERROR = /^Reconnecting\.\.\.\s*\d+\/\d+/i;

export function parseCodexJsonlLine(line: string): CodexJsonlEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as CodexJsonlEvent;
  } catch {
    return null;
  }
}

export function mapCodexEvent(event: CodexJsonlEvent): CodexMapped[] {
  const type = event.type ?? "";
  if (type === "thread.started" || type === "turn.started") {
    return [{ kind: "status", status: "running" }];
  }
  if (type === "turn.completed") {
    return [{ kind: "turn_done" }];
  }
  if (type === "turn.failed") {
    return [{ kind: "error", message: errorText(event.error) || "Codex turn failed" }];
  }
  if (type === "error") {
    const message = event.message || errorText(event.error);
    if (!message || TRANSIENT_ERROR.test(message)) return [{ kind: "ignore" }];
    return [{ kind: "error", message }];
  }
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    return mapItem(type, event.item ?? {});
  }
  return [{ kind: "ignore" }];
}

function mapItem(eventType: string, item: CodexItem): CodexMapped[] {
  const id = item.id || "codex_item";
  const itemType = item.type ?? "";

  if (itemType === "agent_message") {
    if (eventType !== "item.completed") return [{ kind: "ignore" }];
    const text = item.text?.trim() ?? "";
    return text ? [{ kind: "assistant", content: text }] : [{ kind: "ignore" }];
  }

  if (itemType === "reasoning") {
    return [{ kind: "ignore" }];
  }

  if (itemType === "command_execution") {
    const args = { command: item.command ?? "" };
    if (eventType === "item.started") {
      return [{ kind: "tool_start", id, name: "run_shell", arguments: args }];
    }
    if (eventType === "item.completed") {
      const ok = item.status !== "failed" && (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0);
      const output = formatCommandOutput(item);
      return [{ kind: "tool_end", id, name: "run_shell", ok, output }];
    }
    return [{ kind: "ignore" }];
  }

  if (itemType === "mcp_tool_call" || itemType === "collab_tool_call") {
    const name = item.tool || itemType;
    const args = item.arguments ?? {};
    if (eventType === "item.started") {
      return [{ kind: "tool_start", id, name, arguments: args }];
    }
    if (eventType === "item.completed") {
      const ok = item.status !== "failed" && !item.error;
      return [{ kind: "tool_end", id, name, ok, output: formatMcpOutput(item) }];
    }
    return [{ kind: "ignore" }];
  }

  if (itemType === "file_change" || itemType === "apply_patch") {
    const out: CodexMapped[] = [];
    if (eventType === "item.started") {
      out.push({
        kind: "tool_start",
        id,
        name: "apply_patch",
        arguments: { changes: item.changes ?? [] },
      });
    }
    if (eventType === "item.completed") {
      const ok = item.status !== "failed";
      const changes = item.changes ?? [];
      out.push({
        kind: "tool_end",
        id,
        name: "apply_patch",
        ok,
        output: formatFileChanges(changes),
      });
      for (const change of changes) {
        const path = change.path?.trim();
        if (!path) continue;
        out.push({ kind: "artifact", path, action: kindToAction(change.kind) });
      }
    }
    return out.length ? out : [{ kind: "ignore" }];
  }

  if (itemType === "web_search") {
    const args = { query: item.query ?? "" };
    if (eventType === "item.started") {
      return [{ kind: "tool_start", id, name: "web_search", arguments: args }];
    }
    if (eventType === "item.completed") {
      return [
        {
          kind: "tool_end",
          id,
          name: "web_search",
          ok: item.status !== "failed",
          output: item.query ? `query: ${item.query}` : "web search",
        },
      ];
    }
    return [{ kind: "ignore" }];
  }

  if (itemType === "error") {
    const message = item.message || item.text || "Codex item error";
    return [{ kind: "error", message }];
  }

  if (itemType === "todo_list") {
    return [{ kind: "ignore" }];
  }

  return [{ kind: "ignore" }];
}

function errorText(error: CodexJsonlEvent["error"] | CodexItem["error"]): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message ?? "";
}

function formatCommandOutput(item: CodexItem): string {
  const parts: string[] = [];
  if (item.command) parts.push(`$ ${item.command}`);
  if (item.exit_code !== undefined && item.exit_code !== null) {
    parts.push(`exit ${item.exit_code}`);
  }
  if (item.aggregated_output?.trim()) parts.push(item.aggregated_output.trim());
  return parts.join("\n") || "(no output)";
}

function formatMcpOutput(item: CodexItem): string {
  const err = errorText(item.error);
  if (err) return err;
  const result = item.result;
  if (result && typeof result === "object") {
    const rec = result as { content?: unknown; structured_content?: unknown };
    if (Array.isArray(rec.content)) {
      const texts = rec.content
        .map((block) => {
          if (block && typeof block === "object" && "text" in block) {
            return String((block as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return item.status === "failed" ? "tool failed" : "ok";
}

function formatFileChanges(changes: Array<{ path?: string; kind?: string }>): string {
  if (changes.length === 0) return "file change";
  return changes.map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`.trim()).join("\n");
}

function kindToAction(kind?: string): ArtifactAction {
  if (kind === "add" || kind === "create" || kind === "created") return "created";
  if (kind === "delete" || kind === "deleted") return "deleted";
  return "modified";
}
