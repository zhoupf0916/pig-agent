/**
 * On-demand MCP tool search ("tool search tool" pattern).
 *
 * With many MCP tools mounted, shipping every JSON schema on every request wastes context and
 * hurts tool selection. Above a threshold we expose a single `search_tools` meta-tool instead;
 * the model searches by intent, and matching tools become callable from the next model call on.
 * Activation is sticky for the session (session.activatedTools) so the tool prefix stays stable
 * and the prompt cache only misses once per activation.
 */
import { parseMcpToolName } from "@pig-agent/contracts";
import { bm25Scores } from "../store/memory-search.ts";

export const TOOL_SEARCH = "search_tools";
type ToolDef = { type: "function"; function: { name: string; description?: string; parameters: unknown } };

export function toolSearchThreshold(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PIG_TOOL_SEARCH === "off") return Number.POSITIVE_INFINITY;
  if (env.PIG_TOOL_SEARCH === "on") return 0;
  const n = Number(env.PIG_TOOL_SEARCH_THRESHOLD);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

export const toolSearchDefinition: ToolDef = {
  type: "function",
  function: {
    name: TOOL_SEARCH,
    description: "Search the connected external (MCP) tools by intent. Matching tools become callable on your next step. Use this before concluding that no tool exists for a task.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, e.g. 'create a github issue' or '查询日历'" },
        limit: { type: "integer", minimum: 1, maximum: 8, description: "Max tools to activate (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

/** Decide which MCP tool schemas to send this call. */
export function selectMcpTools(all: ToolDef[], activated: readonly string[] | undefined, threshold = toolSearchThreshold()): { tools: ToolDef[]; searchEnabled: boolean } {
  if (all.length <= threshold) return { tools: all, searchEnabled: false };
  const on = new Set(activated ?? []);
  return { tools: all.filter((t) => on.has(t.function.name)), searchEnabled: true };
}

function docOf(t: ToolDef): string {
  const props = (t.function.parameters as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
  const parsed = parseMcpToolName(t.function.name);
  const name = parsed?.tool ?? t.function.name;
  return stem(`${name.replace(/[_.-]+/g, " ")} ${name} ${parsed?.serverId ?? ""} ${t.function.description ?? ""} ${Object.keys(props).join(" ").replace(/[_-]+/g, " ")}`);
}

/** Tiny plural folding so "issues" matches "issue". */
function stem(text: string): string {
  return text.replace(/\b([A-Za-z]{2,}[a-rt-zA-RT-Z])s\b/g, "$1");
}

export function searchTools(all: ToolDef[], query: string, limit = 5): ToolDef[] {
  const q = query.trim();
  if (!q) return [];
  const scores = bm25Scores(stem(q), all.map(docOf));
  return all
    .map((t, i) => ({ t, s: scores[i] ?? 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.function.name.localeCompare(b.t.function.name))
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map((x) => x.t);
}

export function runToolSearch(all: ToolDef[], args: { query?: unknown; limit?: unknown }, activated: string[]): { output: string; activated: string[] } {
  const hits = searchTools(all, String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 5);
  if (!hits.length) return { output: `没有找到匹配“${String(args.query ?? "")}”的外部工具（共 ${all.length} 个可搜索）。换个说法再试，或用内置工具完成。`, activated };
  const next = [...new Set([...activated, ...hits.map((h) => h.function.name)])].sort();
  const lines = hits.map((h) => {
    const props = Object.keys((h.function.parameters as { properties?: object } | undefined)?.properties ?? {});
    return `- ${h.function.name}(${props.join(", ")}): ${(h.function.description ?? "").slice(0, 160)}`;
  });
  return { output: `已激活 ${hits.length} 个工具，下一步即可直接调用：\n${lines.join("\n")}`, activated: next };
}
