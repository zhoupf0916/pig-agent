/**
 * Scenario router for the offline mock LLM. Pure function so it can be unit-tested
 * and reused by e2e/eval harnesses. A scenario is chosen from the latest user
 * message (or forced with MOCK_LLM_SCENARIO / a "[mock:<name>]" tag), and each
 * scenario is a small state machine keyed on how many tool rounds have happened.
 */
export type MockMessage = { role?: string; content?: unknown; tool_calls?: unknown };
export type MockToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type MockReply = { content?: string; toolCalls?: MockToolCall[] };
export type ScenarioName = "readme" | "list" | "write" | "shell" | "read" | "chat" | "fail";

const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string })?.text ?? "").join("") : "");

export function lastUserText(messages: MockMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") {
    const t = text(messages[i]!.content);
    if (!t.startsWith("[harness]")) return t;
  }
  return "";
}

/** Tool results since the latest real user turn. */
function toolRounds(messages: MockMessage[]): MockMessage[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && !text(messages[i]!.content).startsWith("[harness]")) { start = i; break; }
  return messages.slice(start).filter((m) => m.role === "tool");
}

export function pickScenario(userText: string, forced?: string): ScenarioName {
  const tag = /\[mock:(\w+)\]/.exec(userText)?.[1] ?? forced;
  if (tag && ["readme", "list", "write", "shell", "read", "chat", "fail"].includes(tag)) return tag as ScenarioName;
  const t = userText.toLowerCase();
  if (/(运行|执行|run|exec)\s*[`:：]/.test(t) || /`[^`]+`/.test(userText) && /(运行|执行|run)/.test(t)) return "shell";
  if (/(写|创建|新建|write|create)[^\n]*?[\w.-]+\.\w+/.test(t)) return "write";
  if (/(读|查看|打开|read|open|cat)\s*[^\n]*?[\w.-]+\.\w+/.test(t)) return "read";
  if (/(列出|列表|有哪些文件|list|ls\b)/.test(t)) return "list";
  if (/readme|摘要|整理工作区|summar/.test(t)) return "readme";
  return "chat";
}

const fileIn = (t: string) => /([\w./-]+\.[A-Za-z0-9]{1,8})/.exec(t)?.[1];

export function mockReply(messages: MockMessage[], forced = process.env.MOCK_LLM_SCENARIO): MockReply {
  const user = lastUserText(messages);
  const scenario = pickScenario(user, forced);
  const rounds = toolRounds(messages);
  const done = rounds.length > 0;
  const lastTool = text(rounds.at(-1)?.content).slice(0, 400);
  switch (scenario) {
    case "readme":
      return done ? { content: "已更新 `README.md`。请在右侧「产物」中打开预览，确认工作区摘要是否符合预期。" } : { toolCalls: [
        { id: "call_plan", name: "update_plan", arguments: { steps: [{ title: "查看工作区", status: "done" }, { title: "撰写摘要 README", status: "running" }] } },
        { id: "call_search", name: "search_files", arguments: { query: "todo", path: "." } },
        { id: "call_write", name: "write_file", arguments: { path: "README.md", content: "# Demo workspace\n\nThis README was written by the local mock LLM so you can review an artifact without a live API key.\n\n## Layout\n- `notes/` meeting notes and todos\n- `drafts/` unfinished ideas\n- `scattered-log.txt` leftover log\n\nAsk DeepSeek (or another OpenAI-compatible model) for a richer rewrite.\n" } },
      ] };
    case "list":
      return done ? { content: `工作区文件如下（mock）：\n\n${lastTool}` } : { toolCalls: [{ id: "call_list", name: "list_dir", arguments: { path: "." } }] };
    case "read": {
      const path = fileIn(user) ?? "README.md";
      return done ? { content: `已读取 \`${path}\`（mock），前 400 字：\n\n${lastTool}` } : { toolCalls: [{ id: "call_read", name: "read_file", arguments: { path } }] };
    }
    case "write": {
      const path = fileIn(user) ?? "hello.txt";
      if (rounds.length === 0) return { toolCalls: [{ id: "call_list", name: "list_dir", arguments: { path: "." } }] };
      if (rounds.length === 1) return { toolCalls: [{ id: "call_write", name: "write_file", arguments: { path, content: `hello from mock LLM\n` } }] };
      return { content: `已写入 \`${path}\`（mock）。请在「产物」中核对。` };
    }
    case "shell": {
      const command = /`([^`]+)`/.exec(user)?.[1] ?? /(?:运行|执行|run|exec)\s*[:：]\s*(.+)$/i.exec(user)?.[1]?.trim() ?? "echo hello";
      return done ? { content: `命令 \`${command}\` 已执行（mock），输出：\n\n${lastTool}` } : { toolCalls: [{ id: "call_shell", name: "run_shell", arguments: { command } }] };
    }
    case "fail":
      return rounds.length < 3 ? { toolCalls: [{ id: `call_fail_${rounds.length}`, name: "read_file", arguments: { path: "does-not-exist.txt" } }] } : { content: "多次失败，已停止（mock）。" };
    default:
      return { content: `（mock 模型）收到：${user.slice(0, 200)}` };
  }
}
