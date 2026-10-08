/**
 * Read-only sub-agents ("spawn_subagent").
 *
 * The parent delegates a self-contained investigation (search a codebase, read many files,
 * digest a long log). The sub-agent runs in a fresh context window with only read-only
 * tools, so it needs no approval and cannot mutate the workspace; only its concise final
 * report returns to the parent. Several spawn calls in one response run in parallel.
 */
import type { ChatMessage, Settings } from "../types.ts";
import { complete, type TokenUsage } from "./openai.ts";
import { executeTool, type ToolContext } from "./tools.ts";
import { newId, nowIso } from "../util.ts";

export const SUBAGENT_TOOL = "spawn_subagent";
export const SUBAGENT_READONLY_TOOLS = ["read_file", "list_dir", "search_files", "list_skills", "load_skill"];
export const SUBAGENT_MAX_TURNS = 8;
export const SUBAGENT_MAX_PARALLEL = 3;
export const SUBAGENT_REPORT_CHARS = 4000;

export const subagentToolDefinition = {
  type: "function" as const,
  function: {
    name: SUBAGENT_TOOL,
    description: "把一个独立、只读的调查子任务交给子 Agent（全新上下文，只能 list_dir/search_files/read_file/load_skill，不能写文件或执行命令）。适合：通读多个文件、在大量内容里找证据、并行调查多个方向。只返回子 Agent 的结论报告，原始工具输出不会进入你的上下文。同一轮可并行发起多个（最多 3 个）。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "完整、自包含的任务说明：要找什么、范围（路径）、期望的输出格式。子 Agent 看不到当前对话。" },
        name: { type: "string", description: "简短名称，用于展示，如「调查日志错误」" },
      },
      required: ["task"],
    },
  },
};

const SYSTEM = [
  "你是 Pig Agent 的只读子 Agent。只用提供的只读工具完成父 Agent 交代的调查任务。",
  "规则：不要猜测未读到的内容；需要时先 list_dir / search_files 定位，再 read_file。",
  `最多 ${SUBAGENT_MAX_TURNS} 轮工具调用。完成后直接输出给父 Agent 的报告（简体中文）：结论、关键证据（路径:行号/原文要点）、未确认事项。报告不超过 1500 字。`,
].join("\n");

export type SubagentResult = { report: string; rounds: number; toolCalls: number; usage: { input: number; output: number }; truncated: boolean };

export async function runSubagent(input: { settings: Settings; task: string; ctx: ToolContext; signal: AbortSignal; maxTurns?: number; onUsage?: (u: TokenUsage) => void }): Promise<SubagentResult> {
  const { settings, task, ctx, signal } = input;
  if (!task.trim()) throw new Error("spawn_subagent 需要 task");
  const maxTurns = input.maxTurns ?? SUBAGENT_MAX_TURNS;
  const messages: ChatMessage[] = [
    { id: newId("msg"), role: "system", content: `${SYSTEM}\n工作区：${ctx.workspaceRoot}`, createdAt: nowIso() },
    { id: newId("msg"), role: "user", content: task, createdAt: nowIso() },
  ];
  const usage = { input: 0, output: 0 };
  let toolCalls = 0;
  const childCtx: ToolContext = { ...ctx, transcript: () => messages };
  for (let round = 0; round < maxTurns; round++) {
    if (signal.aborted) throw new Error("Aborted");
    const last = round === maxTurns - 1;
    if (last) messages.push({ id: newId("msg"), role: "user", content: "[harness] 工具轮数已用完。基于已获得的证据直接写报告。", createdAt: nowIso() });
    const res = await complete(settings, messages, {
      signal, onlyTools: SUBAGENT_READONLY_TOOLS, allowTools: !last, maxOutputTokens: 2048,
      onUsage: (u) => { usage.input += u.prompt_tokens; usage.output += u.completion_tokens; input.onUsage?.(u); },
    });
    const calls = res.toolCalls.filter((c) => SUBAGENT_READONLY_TOOLS.includes(c.name));
    messages.push({ id: newId("msg"), role: "assistant", content: res.content, reasoningContent: res.reasoningContent, toolCalls: res.toolCalls.length ? res.toolCalls : undefined, createdAt: nowIso() });
    if (!res.toolCalls.length) return finish(res.content, round + 1, toolCalls, usage);
    for (const call of res.toolCalls) {
      toolCalls++;
      let content: string;
      let ok = true;
      if (!calls.includes(call)) { ok = false; content = `子 Agent 只能使用只读工具，${call.name} 未执行。`; }
      else {
        try { content = (await executeTool(call.name, JSON.parse(call.arguments || "{}"), childCtx)).output; }
        catch (err) { ok = false; content = err instanceof Error ? err.message : String(err); }
      }
      messages.push({ id: newId("msg"), role: "tool", toolCallId: call.id, toolOk: ok, content: content.slice(0, 20000), createdAt: nowIso() });
    }
  }
  const lastText = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "子 Agent 未能在轮数内给出结论。";
  return finish(lastText, maxTurns, toolCalls, usage);
}

function finish(report: string, rounds: number, toolCalls: number, usage: { input: number; output: number }): SubagentResult {
  const truncated = report.length > SUBAGENT_REPORT_CHARS;
  return { report: truncated ? report.slice(0, SUBAGENT_REPORT_CHARS) + "\n…(报告已截断)" : report, rounds, toolCalls, usage, truncated };
}

export function formatSubagentOutput(name: string | undefined, r: SubagentResult): string {
  return `[子 Agent${name ? `「${name}」` : ""}报告｜${r.rounds} 轮，${r.toolCalls} 次只读工具调用]\n${r.report}`;
}
