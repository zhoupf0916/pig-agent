import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapCodexEvent, parseCodexJsonlLine, type CodexMapped } from "./events.ts";

const here = dirname(fileURLToPath(import.meta.url));

function mapFixture(name: string): CodexMapped[] {
  const raw = readFileSync(join(here, "fixtures", name), "utf8");
  const out: CodexMapped[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const event = parseCodexJsonlLine(line);
    if (!event) continue;
    out.push(...mapCodexEvent(event));
  }
  return out.filter((m) => m.kind !== "ignore");
}

describe("Codex JSONL → AgentEvent mapping", () => {
  it("maps a write-file style fixture to status/tools/message/done", () => {
    const mapped = mapFixture("write-file.jsonl");
    const kinds = mapped.map((m) => m.kind);
    expect(kinds.filter((k) => k === "status")).toHaveLength(2);
    expect(mapped.some((m) => m.kind === "tool_start" && m.name === "run_shell")).toBe(true);
    expect(mapped.some((m) => m.kind === "tool_end" && m.name === "run_shell" && m.ok)).toBe(true);
    expect(mapped.some((m) => m.kind === "artifact" && m.path === "hello.md" && m.action === "created")).toBe(
      true,
    );
    expect(mapped.some((m) => m.kind === "assistant" && m.content.includes("hello.md"))).toBe(true);
    expect(kinds).toContain("turn_done");
  });

  it("treats reconnect notices as non-fatal", () => {
    expect(mapCodexEvent({ type: "error", message: "Reconnecting... 1/5" })).toEqual([
      { kind: "ignore" },
    ]);
  });

  it("maps turn.failed to an error", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "boom" } })).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });

  it("maps mcp tool calls to tool_start/tool_end", () => {
    const start = mapCodexEvent({
      type: "item.started",
      item: {
        id: "item_5",
        type: "mcp_tool_call",
        tool: "search",
        arguments: { q: "notes" },
        status: "in_progress",
      },
    });
    const end = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "item_5",
        type: "mcp_tool_call",
        tool: "search",
        arguments: { q: "notes" },
        status: "failed",
        error: { message: "timeout" },
      },
    });
    expect(start).toEqual([
      { kind: "tool_start", id: "item_5", name: "search", arguments: { q: "notes" } },
    ]);
    expect(end).toEqual([{ kind: "tool_end", id: "item_5", name: "search", ok: false, output: "timeout" }]);
  });
});
