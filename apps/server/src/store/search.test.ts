import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { saveSession } from "./sessions.ts";
import {
  clampSearchLimit,
  DEFAULT_SEARCH_LIMIT,
  fieldMatch,
  makeSnippet,
  MAX_SEARCH_LIMIT,
  shouldScanAssetContent,
  tokenizeQuery,
} from "./search.ts";
import type { ProjectAsset, Session } from "../types.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const MARKER = `zxqmil-g-${Date.now().toString(36)}`;

describe("search helpers", () => {
  it("tokenizes and matches substring / AND tokens", () => {
    expect(tokenizeQuery("  调研 报告 ")).toEqual(["调研", "报告"]);
    expect(fieldMatch("请写一份调研报告草稿", "调研报告", tokenizeQuery("调研报告")).matched).toBe(
      true,
    );
    expect(fieldMatch("调研笔记与报告提纲", "调研 报告", tokenizeQuery("调研 报告")).matched).toBe(
      true,
    );
    expect(fieldMatch("只有调研没有后半", "调研 报告", tokenizeQuery("调研 报告")).matched).toBe(
      false,
    );
    expect(fieldMatch("Action Items", "action items", tokenizeQuery("action items")).matched).toBe(
      true,
    );
  });

  it("builds a snippet around the needle", () => {
    const text = "前缀文字 ".repeat(20) + "UNIQUE_NEEDLE 后面还有一些说明";
    const snip = makeSnippet(text, "UNIQUE_NEEDLE", 10);
    expect(snip).toContain("UNIQUE_NEEDLE");
    expect(snip.startsWith("…")).toBe(true);
  });

  it("clamps limit and skips huge / non-text assets", () => {
    expect(clampSearchLimit(Number.NaN)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(999)).toBe(MAX_SEARCH_LIMIT);
    const huge: ProjectAsset = {
      id: "ast_x",
      filename: "notes.md",
      size: 900_000,
      mimeType: "text/markdown",
      createdAt: new Date().toISOString(),
    };
    const png: ProjectAsset = {
      id: "ast_y",
      filename: "shot.png",
      size: 120,
      mimeType: "image/png",
      createdAt: new Date().toISOString(),
    };
    const md: ProjectAsset = {
      id: "ast_z",
      filename: "brief.md",
      size: 80,
      mimeType: "text/markdown",
      createdAt: new Date().toISOString(),
    };
    expect(shouldScanAssetContent(huge)).toBe(false);
    expect(shouldScanAssetContent(png)).toBe(false);
    expect(shouldScanAssetContent(md)).toBe(true);
  });
});

describe("GET /api/search", () => {
  const app = createApp();

  it("returns empty hits for blank q", async () => {
    const res = await app.request("/api/search?q=");
    expect(res.status).toBe(200);
    const body = await json<{ q: string; hits: unknown[] }>(res);
    expect(body.q).toBe("");
    expect(body.hits).toEqual([]);
  });

  it("finds session title and recent message text", async () => {
    const created = await json<Session>(
      await app.request("/api/sessions", { method: "POST" }),
    );
    created.title = `${MARKER} 会话标题`;
    created.messages.push({
      id: "msg_search_1",
      role: "user",
      content: `请抽出会议纪要里的 ${MARKER}-action-items`,
      createdAt: new Date().toISOString(),
    });
    await saveSession(created);

    const byTitle = await json<{ hits: Array<{ type: string; id: string; href: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER} 会话`)}`),
    );
    expect(byTitle.hits.some((h) => h.type === "session" && h.id === created.id)).toBe(true);
    expect(byTitle.hits.find((h) => h.id === created.id)?.href).toBe(`#/sessions/${created.id}`);

    const byMsg = await json<{ hits: Array<{ type: string; snippet: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-action-items`)}`),
    );
    const hit = byMsg.hits.find((h) => h.type === "session");
    expect(hit?.snippet).toContain(`${MARKER}-action-items`);
  });

  it("finds project name, instruction, todo, message, and text asset", async () => {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${MARKER} 协作空间`,
          instruction: `项目指令：先读 ${MARKER}-brief 再动手。`,
        }),
      }),
    );

    await app.request(`/api/projects/${project.id}/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `整理 ${MARKER}-todo` }),
    });
    await app.request(`/api/projects/${project.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `评论：${MARKER}-comment 先拆待办` }),
    });
    const assetRes = await json<{ asset: { id: string; filename: string } }>(
      await app.request(`/api/projects/${project.id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `${MARKER}-notes.md`,
          content: `# 背景\n正文含 ${MARKER}-asset-body 可被检索。`,
          mimeType: "text/markdown",
        }),
      }),
    );

    const nameHits = await json<{ hits: Array<{ type: string; id: string; href: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER} 协作`)}`),
    );
    expect(nameHits.hits.some((h) => h.type === "project" && h.id === project.id)).toBe(true);

    const instHits = await json<{ hits: Array<{ type: string; snippet: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-brief`)}`),
    );
    expect(instHits.hits.some((h) => h.type === "project" && h.snippet.includes(`${MARKER}-brief`))).toBe(
      true,
    );

    const todoHits = await json<{
      hits: Array<{ type: string; todoId?: string; href: string }>;
    }>(await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-todo`)}`));
    const todo = todoHits.hits.find((h) => h.type === "todo");
    expect(todo?.href).toContain(`#/projects/${project.id}`);
    expect(todo?.href).toContain("todo=");

    const msgHits = await json<{ hits: Array<{ type: string; snippet: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-comment`)}`),
    );
    expect(msgHits.hits.some((h) => h.type === "project_message")).toBe(true);

    const fileHits = await json<{
      hits: Array<{ type: string; assetId?: string; href: string }>;
    }>(await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-notes.md`)}`));
    expect(fileHits.hits.some((h) => h.type === "asset" && h.assetId === assetRes.asset.id)).toBe(
      true,
    );

    const bodyHits = await json<{ hits: Array<{ type: string; snippet: string; href: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-asset-body`)}`),
    );
    const assetHit = bodyHits.hits.find((h) => h.type === "asset");
    expect(assetHit?.snippet).toContain(`${MARKER}-asset-body`);
    expect(assetHit?.href).toBe(`#/projects/${project.id}?asset=${assetRes.asset.id}`);
  });

  it("skips binary asset content but still matches the filename", async () => {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${MARKER} 二进制` }),
      }),
    );
    const secret = `${MARKER}-hidden-in-png`;
    const bytes = Buffer.from(`PNG\u0000${secret}`, "utf8");
    await app.request(`/api/projects/${project.id}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: `${MARKER}-shot.png`,
        contentBase64: bytes.toString("base64"),
        mimeType: "image/png",
      }),
    });

    const hidden = await json<{ hits: Array<{ type: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(secret)}`),
    );
    expect(hidden.hits.filter((h) => h.type === "asset")).toEqual([]);

    const named = await json<{ hits: Array<{ type: string; title: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-shot.png`)}`),
    );
    expect(named.hits.some((h) => h.type === "asset" && h.title.includes("shot.png"))).toBe(true);
  });

  it("indexes memory pins and recaps as type memory", async () => {
    const pin = await json<{ id: string; text: string }>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          text: `${MARKER} 记忆钉：只检索本机 JSON`,
          tags: [`${MARKER}-memtag`],
        }),
      }),
    );

    const byText = await json<{ hits: Array<{ type: string; id: string; href: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER} 记忆钉`)}`),
    );
    const hit = byText.hits.find((h) => h.type === "memory" && h.id === pin.id);
    expect(hit?.href).toBe(`#/memory/${pin.id}`);

    const byTag = await json<{ hits: Array<{ type: string; id: string }> }>(
      await app.request(`/api/search?q=${encodeURIComponent(`${MARKER}-memtag`)}`),
    );
    expect(byTag.hits.some((h) => h.type === "memory" && h.id === pin.id)).toBe(true);

    await app.request(`/api/memory/${pin.id}`, { method: "DELETE" });
  });

  it("respects limit and does not invent embeddings fields", async () => {
    const res = await app.request(`/api/search?q=${encodeURIComponent(MARKER)}&limit=2`);
    expect(res.status).toBe(200);
    const body = await json<{
      limit: number;
      hits: Array<{ type: string; href: string; vector?: unknown }>;
    }>(res);
    expect(body.limit).toBe(2);
    expect(body.hits.length).toBeLessThanOrEqual(2);
    for (const hit of body.hits) {
      expect(hit.href.startsWith("#/")).toBe(true);
      expect(hit.vector).toBeUndefined();
    }
  });
});
