import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createExpert, createExpertTeam } from "./store/experts.ts";
import { getSession } from "./store/sessions.ts";
import { saveSettings } from "./store/settings.ts";

const app = createApp();
let completions = 0;
const llm = createServer((req, res) => {
  req.resume();
  completions++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "完成" } }] })}\n\ndata: [DONE]\n\n`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const address = llm.address();
  if (!address || typeof address === "string") throw new Error("No mock address");
  await saveSettings({ llmBaseUrl: `http://127.0.0.1:${address.port}`, llmApiKey: "test", runtime: "pig" });
});
afterAll(async () => {
  llm.closeAllConnections();
  await new Promise<void>((resolve) => llm.close(() => resolve()));
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("user message identity across optimistic UI and SSE", () => {
  it("echoes the client id, keeps identical submissions with different ids, and rejects reuse", async () => {
    const { id } = await (await post("/api/sessions", {})).json() as { id: string };
    const ids = [randomUUID(), randomUUID()];
    for (const clientMessageId of ids) {
      const response = await post(`/api/sessions/${id}/messages`, { content: "继续", clientMessageId });
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain(`"id":"${clientMessageId}"`);
    }
    const before = completions;
    const repeat = await post(`/api/sessions/${id}/messages`, { content: "继续", clientMessageId: ids[0] });
    expect(repeat.status).toBe(409);
    expect(completions).toBe(before);
    expect((await getSession(id))?.messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual(ids);
  });

  it("preserves the same id for a team-run prompt", async () => {
    const expert = await createExpert({ name: "验收专家", instruction: "Reply briefly.", kind: "custom" });
    const team = await createExpertTeam({ name: "验收小队", expertIds: [expert.id], mode: "chain" });
    const { id } = await (await post("/api/sessions", { expertTeamId: team.id })).json() as { id: string };
    const clientMessageId = randomUUID();
    const response = await post(`/api/sessions/${id}/team-run`, { action: "start", content: "检查", clientMessageId });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"id":"${clientMessageId}"`);
    expect((await getSession(id))?.messages.filter((m) => m.id === clientMessageId)).toHaveLength(1);
  });

  it("rejects malformed identities without appending a user message", async () => {
    const { id } = await (await post("/api/sessions", {})).json() as { id: string };
    expect((await post(`/api/sessions/${id}/messages`, { content: "hello", clientMessageId: "bad" })).status).toBe(400);
    expect((await getSession(id))?.messages).toHaveLength(0);
  });
});
