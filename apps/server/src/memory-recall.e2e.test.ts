/**
 * Memory recall end to end through the HTTP app: pins saved via /api/memory, a real chat turn via
 * /api/sessions/:id/messages, a scripted OpenAI-compatible model (and embeddings) server.
 * Verifies that relevant-but-old pins are recalled into the user turn (not the system prompt),
 * scope rules hold, the recall is frozen per user message (stable prompt prefix), and the
 * optional embedding path recalls a note with no lexical overlap.
 */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { saveSettings } from "./store/settings.ts";

process.env.PIG_COMPACTION = "off";
process.env.PIG_SUBAGENTS = "off";
const app = createApp();
const chats: any[] = [];
const embedCalls: string[][] = [];
// Toy semantic space: "deploy/上线/机器/服务器" ↔ axis 0, "food/午饭/吃" ↔ axis 1, everything else axis 2.
const vec = (t: string) => /deploy|上线|机器|服务器|发布|hz-prod/i.test(t) ? [1, 0, 0.05] : /午饭|吃|food|lunch/i.test(t) ? [0, 1, 0.05] : [0.05, 0.05, 1];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (req.url?.endsWith("/embeddings")) {
      embedCalls.push(body.input);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: body.input.map((t: string, index: number) => ({ index, embedding: vec(t) })) }));
    }
    chats.push(body);
    const lastUser = [...body.messages].reverse().find((m: any) => m.role === "user");
    const content = String(lastUser?.content ?? "");
    const m = content.match(/hz-prod-\d+|sg-edge-\d+/);
    const reply = m ? `根据保存的笔记：${m[0]}` : "我没有相关记录";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
  });
});

const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function pin(text: string, extra: Record<string, unknown> = {}) {
  const res = await post("/api/memory", { kind: "pin", text, ...extra });
  expect(res.status).toBeLessThan(300);
  await new Promise((r) => setTimeout(r, 5)); // distinct updatedAt ordering
  return (await res.json()) as { id: string };
}
async function say(sessionId: string, content: string) {
  const res = await post(`/api/sessions/${sessionId}/messages`, { content });
  expect(res.status).toBe(200);
  await res.text();
  return chats.at(-1);
}
const userTurns = (body: any) => body.messages.filter((m: any) => m.role === "user").map((m: any) => String(m.content));
const system = (body: any) => String(body.messages[0]?.content ?? "");

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  await saveSettings({ llmBaseUrl: `http://127.0.0.1:${port}/v1`, llmApiKey: "test", runtime: "pig" });
  process.env.__E2E_PORT = String(port);
});
afterAll(() => { server.close(); delete process.env.PIG_EMBEDDING_BASE_URL; delete process.env.PIG_EMBEDDING_MODEL; });

describe("memory recall e2e", () => {
  it("recalls an old relevant pin into the user turn, keeps scope, and freezes it across turns", async () => {
    await pin("发布目标机器：hz-prod-03（发布前先跑冒烟）", { tags: ["发布"] });
    const other = (await (await post("/api/sessions", {})).json()) as { id: string };
    await pin("发布目标机器：sg-edge-09", { sessionId: other.id }); // another session's note
    for (let i = 0; i < 6; i++) await pin(`无关偏好 ${i}：回答尽量简洁，代码用 TypeScript 第 ${i} 条`);

    const { id } = (await (await post("/api/sessions", {})).json()) as { id: string };
    const first = await say(id, "这次发布的目标机器是哪台？");
    expect(system(first)).not.toContain("hz-prod-03"); // not among the 5 most recent system pins
    const turn1 = userTurns(first).at(-1)!;
    expect(turn1).toContain("Related saved notes");
    expect(turn1).toContain("hz-prod-03");
    expect(turn1).not.toContain("sg-edge-09"); // session-scoped pin from another session
    const session = await (await app.request(`/api/sessions/${id}`)).json() as any;
    expect(session.messages.at(-1).content).toContain("hz-prod-03");

    const second = await say(id, "顺便说下 README 有几行？");
    expect(userTurns(second)[0]).toBe(turn1); // recall frozen on the first user message → identical prefix
    expect(userTurns(second).at(-1)).not.toContain("hz-prod-03");
  });

  it("uses embeddings to recall a pin with no lexical overlap", async () => {
    process.env.PIG_EMBEDDING_BASE_URL = `http://127.0.0.1:${process.env.__E2E_PORT}/v1`;
    process.env.PIG_EMBEDDING_MODEL = "toy-embed";
    const { id } = (await (await post("/api/sessions", {})).json()) as { id: string };
    const body = await say(id, "服务器上线到哪里去？");
    expect(embedCalls.length).toBeGreaterThan(0);
    expect(userTurns(body).at(-1)).toContain("hz-prod-03");
    expect(userTurns(body).at(-1)).not.toContain("无关偏好");
  });
});
