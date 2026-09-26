import { describe, expect, it } from "vitest";
import type { ChatMessage, LiveTool } from "../types";
import { buildTurns, mergeTools } from "./conversation-turns";

const at = "2026-09-24T00:00:00.000Z";
const title = (name: string) => name;

function tool(partial: Partial<LiveTool> & Pick<LiveTool, "id">): LiveTool {
  return { name: partial.name ?? "read_file", arguments: { path: "a.txt" }, done: true, ok: true, ...partial };
}

describe("conversation activity grouping", () => {
  it("keeps earlier tools when a later live tool arrives", () => {
    const merged = mergeTools(
      [tool({ id: "old", output: "第一轮全文" }), tool({ id: "live", done: false, ok: undefined })],
      [tool({ id: "live", name: "search_files", done: false, arguments: { q: "now" } })],
    );
    expect(merged.map((item) => item.id)).toEqual(["old", "live"]);
    expect(merged[0]?.output).toBe("第一轮全文");
    expect(merged[1]?.name).toBe("search_files");
  });

  it("keeps author and attachments on the matching turn and treats live tool text as progress", () => {
    const turns = buildTurns({
      messages: [
        { id: "prompt:run_a", role: "user", content: "第一轮", createdAt: at, author: "甲", attachments: [{ id: "f1", name: "a.txt", href: "/a" }] },
        { id: "answer", role: "assistant", content: "好。", createdAt: at },
        { id: "prompt:run_b", role: "user", content: "第二轮", createdAt: at, author: "乙", attachments: [{ id: "f2", name: "b.txt", href: "/b" }] },
        { id: "live", role: "assistant", content: "我先读取。", createdAt: at, toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }] },
      ],
      tools: [],
      toolTitle: title,
      streaming: false,
      pendingApproval: false,
    });
    expect(turns[0]).toMatchObject({ author: "甲", attachments: [{ id: "f1" }] });
    expect(turns[1]).toMatchObject({ author: "乙", attachments: [{ id: "f2" }], outcome: "no_answer" });
    expect(turns[1]?.answer).toBeUndefined();
    expect(turns[0]?.attachments?.some((file) => file.id === "f2")).toBe(false);
  });

  it("keeps the full tool output available after the summary is shortened", () => {
    const output = "完整工具输出".repeat(300);
    const turns = buildTurns({
      messages: [
        { id: "u1", role: "user", content: "整理目录", createdAt: at },
        { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }], createdAt: at },
        { id: "final", role: "assistant", content: "目录里有两份周报。", createdAt: at },
      ],
      tools: [tool({ id: "t1", output })],
      toolTitle: title,
      streaming: false,
      pendingApproval: false,
    });
    expect(turns[0]?.collapsed[0]?.output).toBe(output);
    expect((turns[0]?.collapsed[0]?.detail.length ?? 0)).toBeLessThanOrEqual(160);
  });

  it("collapses finished successful tools and keeps the final answer separate from progress text", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "整理目录", createdAt: at },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }, { id: "t2", name: "list_dir", arguments: "{}" }], createdAt: at },
      { id: "final", role: "assistant", content: "目录里有两份周报。", createdAt: at },
    ];
    const turns = buildTurns({
      messages,
      tools: [tool({ id: "t1" }), tool({ id: "t2", name: "list_dir" })],
      toolTitle: title,
      streaming: false,
      pendingApproval: false,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.collapsed.map((row) => row.id)).toEqual(["t1", "t2"]);
    expect(turns[0]?.visible).toEqual([]);
    expect(turns[0]?.answer).toBe("目录里有两份周报。");
    expect(turns[0]?.outcome).toBe("answered");
    expect(turns[0]?.notice).toBeUndefined();
  });

  it("keeps failures and pending approvals outside the collapsed group", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "改文件", createdAt: at },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "ok1", name: "read_file", arguments: "{}" }, { id: "bad", name: "write_file", arguments: "{}" }, { id: "ask", name: "run_shell", arguments: "{}" }], createdAt: at },
    ];
    const turns = buildTurns({
      messages,
      tools: [
        tool({ id: "ok1" }),
        tool({ id: "bad", name: "write_file", ok: false, output: "Error: denied" }),
        tool({ id: "ask", name: "run_shell", done: false, ok: undefined, output: "待批准写入" }),
      ],
      toolTitle: title,
      streaming: false,
      pendingApproval: true,
    });
    expect(turns[0]?.collapsed.map((row) => row.id)).toEqual(["ok1"]);
    expect(turns[0]?.visible.map((row) => row.state)).toEqual(["failed", "approval"]);
    expect(turns[0]?.outcome).toBe("approval");
  });

  it("shows only the current action while running and does not treat progress as a success summary", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "继续", createdAt: at },
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "done1", name: "read_file", arguments: "{}" }, { id: "now", name: "search_files", arguments: "{\"q\":\"周报\"}" }], createdAt: at },
    ];
    const turns = buildTurns({
      messages,
      tools: [tool({ id: "done1" }), tool({ id: "now", name: "search_files", done: false, arguments: { q: "周报" } })],
      toolTitle: title,
      streaming: true,
      pendingApproval: false,
    });
    expect(turns[0]?.outcome).toBe("running");
    expect(turns[0]?.current?.id).toBe("now");
    expect(turns[0]?.current?.detail).toContain("周报");
    expect(turns[0]?.collapsed.map((row) => row.id)).toEqual(["done1"]);
    expect(turns[0]?.answer).toBeUndefined();
    expect(turns[0]?.notice).not.toMatch(/成功|完成总结/);
  });

  it("covers cancel, failure, and a turn that never produced a final answer", () => {
    const base = (id: string, content: string): ChatMessage[] => [
      { id: `u-${id}`, role: "user", content: "目标", createdAt: at },
      { id, role: "assistant", content, createdAt: at },
    ];
    const cancelled = buildTurns({ messages: base("c", "已停止。已完成的步骤仍可审阅。"), tools: [], toolTitle: title, streaming: false, pendingApproval: false });
    const failed = buildTurns({ messages: base("f", "正在读取文件"), tools: [], toolTitle: title, streaming: false, pendingApproval: false, lastError: "本轮执行失败" });
    const empty = buildTurns({ messages: [{ id: "u", role: "user", content: "目标", createdAt: at }], tools: [], toolTitle: title, streaming: false, pendingApproval: false });
    expect(cancelled[0]?.outcome).toBe("cancelled");
    expect(cancelled[0]?.answer).toBeUndefined();
    expect(failed[0]?.outcome).toBe("failed");
    expect(failed[0]?.notice).toBe("本轮执行失败");
    expect(failed[0]?.answer).toBe("正在读取文件");
    expect(empty[0]?.outcome).toBe("no_answer");
    expect(empty[0]?.notice).toBe("本轮没有最终回答");
  });
});

it("attaches upload receipts to the following turn without inventing an unanswered user request", () => {
  const turns = buildTurns({messages:[
    {id:'upload',role:'user',content:'已上传资料：uploads/input.txt',createdAt:at,synthetic:'attachment'},
    {id:'question',role:'user',content:'请核对附件',createdAt:at},
    {id:'answer',role:'assistant',content:'核对完成',createdAt:at},
  ],tools:[],toolTitle:title,streaming:false,pendingApproval:false});
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({userText:'请核对附件',answer:'核对完成',outcome:'answered'});
  expect(turns[0]?.notes).toContain('已上传资料：uploads/input.txt');
});

it('presents an unexecuted cancelled tool as cancelled rather than a tool failure', () => {
  const turns=buildTurns({messages:[
    {id:'u',role:'user',content:'写文件',createdAt:at},
    {id:'a',role:'assistant',content:'',createdAt:at,toolCalls:[{id:'c',name:'write_file',arguments:'{}'}]},
    {id:'stop',role:'assistant',content:'已停止。本轮未批准的操作不会执行。',createdAt:at},
  ],tools:[tool({id:'c',name:'write_file',ok:false,output:'用户已取消本轮，操作未执行。'})],toolTitle:title,streaming:false,pendingApproval:false});
  expect(turns[0]?.outcome).toBe('cancelled');
  expect(turns[0]?.visible[0]?.state).toBe('cancelled');
});
