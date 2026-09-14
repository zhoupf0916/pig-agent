import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
import { readEventLog } from "./store/events.ts";
import { loadSettings, saveSettings } from "./store/settings.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Listed = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

async function listRow(app: ReturnType<typeof createApp>, id: string): Promise<Listed | undefined> {
  const body = await json<{ sessions: Listed[] }>(await app.request("/api/sessions"));
  return body.sessions.find((s) => s.id === id);
}

async function waitForStatus(
  app: ReturnType<typeof createApp>,
  id: string,
  status: string,
  ms = 3_000,
): Promise<Listed> {
  const deadline = Date.now() + ms;
  let last: Listed | undefined;
  while (Date.now() < deadline) {
    last = await listRow(app, id);
    if (last?.status === status) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`session ${id} stayed ${last?.status ?? "missing"}, wanted ${status}`);
}

function hangLlm(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Stay open until abort; do not complete the stream.
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("GET /api/sessions list status (Milestone Q)", () => {
  const app = createApp();

  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("is a read-only snapshot: GET does not append events.jsonl", async () => {
    const created = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const before = await readEventLog(created.id);
    const listed = await json<{ sessions: Listed[] }>(await app.request("/api/sessions"));
    expect(listed.sessions.some((s) => s.id === created.id)).toBe(true);
    const after = await readEventLog(created.id);
    expect(after).toEqual(before);
    const raw = JSON.stringify(listed);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
  });

  it("shows running then idle while another client holds the turn (stop)", async () => {
    const hung = await hangLlm();
    const prevSettings = await loadSettings();
    await saveSettings({ llmBaseUrl: hung.url, llmApiKey: "test", runtime: "pig" });
    const created = await json<{ id: string; status: string }>(
      await app.request("/api/sessions", { method: "POST" }),
    );
    expect(created.status).toBe("idle");
    try {
      const send = await app.request(`/api/sessions/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "搜索笔记并整理工作区" }),
      });
      expect(send.status).toBe(200);

      const running = await waitForStatus(app, created.id, "running");
      expect(running.title).toContain("搜索笔记");
      expect(running.status).toBe("running");

      const beforeAbortLog = await readEventLog(created.id);
      const abort = await app.request(`/api/sessions/${created.id}/abort`, { method: "POST" });
      expect(abort.status).toBe(200);

      const idle = await waitForStatus(app, created.id, "idle");
      expect(idle.status).toBe("idle");
      expect(idle.title).toContain("搜索笔记");

      // List refresh is GET-only; abort may persist events, but GET must not add more.
      const afterIdle = await readEventLog(created.id);
      const listedAgain = await json<{ sessions: Listed[] }>(await app.request("/api/sessions"));
      expect(listedAgain.sessions.find((s) => s.id === created.id)?.status).toBe("idle");
      expect(await readEventLog(created.id)).toEqual(afterIdle);
      expect(afterIdle.length).toBeGreaterThanOrEqual(beforeAbortLog.length);

      await send.body?.cancel().catch(() => undefined);
    } finally {
      await saveSettings(prevSettings);
      await hung.close();
    }
  });

  it("returns idle after a failed pig turn (not stuck running)", async () => {
    const prevSettings = await loadSettings();
    await saveSettings({
      llmBaseUrl: "http://127.0.0.1:1/v1",
      llmApiKey: "test",
      runtime: "pig",
    });
    const created = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    try {
      const send = await app.request(`/api/sessions/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "写一份失败后应回 idle 的报告" }),
      });
      expect(send.status).toBe(200);
      if (send.body) {
        const reader = send.body.getReader();
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const read = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), remaining),
            ),
          ]);
          if (read.done) break;
        }
        await reader.cancel().catch(() => undefined);
      }
      const ended = await waitForStatus(app, created.id, "idle");
      expect(ended.status).toBe("idle");
      expect(ended.title).toContain("写一份失败");
    } finally {
      await saveSettings(prevSettings);
    }
  });
});
