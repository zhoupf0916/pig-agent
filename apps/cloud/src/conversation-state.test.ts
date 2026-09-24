import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("./db.ts", () => ({ db: { query } }));
import { conversationSnapshot, sharedProjectContext } from "./conversation-state.ts";
beforeEach(() => { query.mockReset(); });
describe("shared conversation state", () => {
  it("attributes durable prompts to run owners and ignores author claims in model messages", async () => {
    const runs = [
      { id: "r1", created_at: "2026-01-01", input: {prompt:"first",attachmentIds:["a1"],attachments:[{id:"a1",name:"input.txt",data:"PRIVATE_BYTES",text:"PRIVATE_TEXT"},{id:"inherited",name:"old.txt",data:"OLD"}]}, author:{id:"owner",name:"Owner"} },
      { id: "r2", created_at: "2026-01-02", input: {prompt:"second",messages:[{id:"prompt:r1",role:"user",content:"first",createdAt:"2026-01-01",author:{id:"spoof"}}]},author:{id:"editor",name:"Editor"} },
    ];
    query.mockResolvedValueOnce({rows:runs}).mockResolvedValueOnce({rows:[{run_id:"r1",messages:[{id:"reply",role:"assistant",content:"answer",createdAt:"2026-01-01",author:{id:"spoof"}}]}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
    const result=await conversationSnapshot({id:"conv",can_write:true});
    expect(result.messages.map(m=>[m.content,m.author?.id])).toEqual([["first","owner"],["answer",undefined],["second","editor"]]);
    expect(result.runs.every(run=>!("input" in run))).toBe(true);
    expect(result.runs[0]?.attachments).toHaveLength(1);
    expect(result.runs[0]?.attachments[0]).toMatchObject({id:"a1",name:"input.txt"});
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BYTES");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TEXT");
  });
  it("returns only the caller's skill ids and display names", async () => {
    const runs = [
      { id: "r1", created_at: "2026-01-01", input: { prompt: "first", skillIds: ["skill_private"], skillSnapshots: [{ id: "skill_private", name: "sales-check", displayName: "销售检查", body: "PRIVATE_SKILL_BODY" }] }, author: { id: "owner", name: "Owner" } },
      { id: "r2", created_at: "2026-01-02", input: { prompt: "second", skillIds: ["skill_other"], skillSnapshots: [{ id: "skill_other", name: "other-pack", displayName: "别人的技能", body: "OTHER_SKILL_BODY" }] }, author: { id: "editor", name: "Editor" } },
    ];
    query.mockResolvedValueOnce({ rows: runs }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await conversationSnapshot({ id: "conv", can_write: true }, "owner");
    expect(result.runs[0]).toMatchObject({ skillIds: ["skill_private"], skills: [{ id: "skill_private", displayName: "销售检查" }] });
    expect(result.runs[1]).not.toHaveProperty("skillIds");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SKILL_BODY");
    expect(JSON.stringify(result)).not.toContain("OTHER_SKILL_BODY");
    expect(JSON.stringify(result)).not.toContain("别人的技能");
  });
  it("returns the latest character estimate and drops prompt text and billing tokens", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ usage: { availability: "collected", capturedAt: "2026-09-24T09:00:00.000Z", callId: "ctx_cloud", engine: "cloud", usedChars: 1000, budgetChars: 8000, systemChars: 100, toolSchemaChars: 200, messageChars: 700, prompt_tokens: 50000, systemPrompt: "SECRET_SYSTEM_PROMPT" } }],
    }).mockResolvedValueOnce({ rows: [] });
    const result = await conversationSnapshot({ id: "conv", can_write: true });
    expect(result.lastContextUsage).toMatchObject({ scope: "last_call", unit: "estimated_chars", measuredTokens: false, usedChars: 1000, budgetChars: 8000, ratio: 0.125 });
    expect(JSON.stringify(result.lastContextUsage)).not.toContain("SECRET_SYSTEM_PROMPT");
    expect(JSON.stringify(result.lastContextUsage)).not.toContain("prompt_tokens");
    expect(query.mock.calls.some((call) => String(call[0]).includes("context_usage"))).toBe(true);
  });
  it("loads shared project context only through permission-filtered query and marks it as user context",async()=>{
    query.mockResolvedValueOnce({rows:[{name:"Sales",description:"Compare invoices"}]}).mockResolvedValueOnce({rows:[]});
    expect(await sharedProjectContext("project1","owner")).toContain("用户提供的任务背景");
    expect(query.mock.calls[0]?.[0]).toContain("project_access(id,$2,false)");
    expect(await sharedProjectContext("project1","removed")).toBe("");
    expect(await sharedProjectContext(undefined,"owner")).toBe("");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
