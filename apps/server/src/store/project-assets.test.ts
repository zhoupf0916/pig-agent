import { describe, expect, it } from "vitest";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../app.ts";
import { PROJECT_ROOT } from "../config.ts";
import { nowIso } from "../util.ts";
import { saveSession } from "./sessions.ts";
import { classifyAssetPreview } from "./asset-preview.ts";
import { recentSavableArtifactPaths } from "./artifacts-to-project.ts";
import type { Session } from "../types.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("asset preview kinds", () => {
  it("classifies markdown, json, images, and text", () => {
    expect(classifyAssetPreview("brief.md", "text/markdown")).toBe("markdown");
    expect(classifyAssetPreview("data.json", "application/json")).toBe("json");
    expect(classifyAssetPreview("shot.png", "image/png")).toBe("image");
    expect(classifyAssetPreview("notes.txt", "text/plain")).toBe("text");
    expect(classifyAssetPreview("blob.bin", "application/octet-stream")).toBe("binary");
  });

  it("picks recent savable artifacts for handoff attach", () => {
    const session = {
      artifacts: [
        { path: "old.md", action: "created" as const, updatedAt: "2026-01-01T00:00:00.000Z" },
        { path: "gone.md", action: "deleted" as const, updatedAt: "2026-09-01T00:00:00.000Z" },
        { path: "new.md", action: "modified" as const, updatedAt: "2026-09-14T00:00:00.000Z" },
      ],
    } as Session;
    expect(recentSavableArtifactPaths(session, 1)).toEqual(["new.md"]);
  });
});

describe("project asset preview / download / handoff", () => {
  const app = createApp();

  async function seedProject(name = "资产预览"): Promise<string> {
    const created = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
    return created.id;
  }

  it("previews markdown and json, downloads bytes", async () => {
    const id = await seedProject();
    const md = await json<{ asset: { id: string } }>(
      await app.request(`/api/projects/${id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "brief.md",
          content: "# 背景\n只做本机协作。",
          mimeType: "text/markdown",
        }),
      }),
    );
    const preview = await json<{
      kind: string;
      content: string;
      binary: boolean;
      asset: { filename: string };
    }>(await app.request(`/api/projects/${id}/assets/${md.asset.id}`));
    expect(preview.kind).toBe("markdown");
    expect(preview.binary).toBe(false);
    expect(preview.content).toContain("# 背景");
    expect(preview.asset.filename).toBe("brief.md");

    const jsonAsset = await json<{ asset: { id: string } }>(
      await app.request(`/api/projects/${id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "meta.json",
          content: "{\"ok\":true}",
          mimeType: "application/json",
        }),
      }),
    );
    const pretty = await json<{ kind: string; content: string }>(
      await app.request(`/api/projects/${id}/assets/${jsonAsset.asset.id}`),
    );
    expect(pretty.kind).toBe("json");
    expect(pretty.content).toContain("\n");
    expect(JSON.parse(pretty.content)).toEqual({ ok: true });

    const download = await app.request(`/api/projects/${id}/assets/${md.asset.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    expect(download.headers.get("Content-Disposition")).toContain("brief.md");
    expect(await download.text()).toContain("# 背景");
  });

  it("previews a png as image base64", async () => {
    const id = await seedProject("图片资产");
    const uploaded = await json<{ asset: { id: string; mimeType: string } }>(
      await app.request(`/api/projects/${id}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "dot.png",
          contentBase64: TINY_PNG.toString("base64"),
          mimeType: "image/png",
        }),
      }),
    );
    const preview = await json<{ kind: string; contentBase64?: string; binary: boolean }>(
      await app.request(`/api/projects/${id}/assets/${uploaded.asset.id}`),
    );
    expect(preview.kind).toBe("image");
    expect(preview.binary).toBe(false);
    expect(preview.contentBase64).toBe(TINY_PNG.toString("base64"));

    const raw = await app.request(
      `/api/projects/${id}/assets/${uploaded.asset.id}/download?inline=1`,
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("image/png");
    expect(raw.headers.get("Content-Disposition")).toContain("inline");
    expect(Buffer.from(await raw.arrayBuffer()).equals(TINY_PNG)).toBe(true);
  });

  it("returns 404 for missing assets", async () => {
    const id = await seedProject("缺失资产");
    const preview = await app.request(`/api/projects/${id}/assets/ast_missing`);
    expect(preview.status).toBe(404);
    const download = await app.request(`/api/projects/${id}/assets/ast_missing/download`);
    expect(download.status).toBe(404);
  });

  it("creates a handoff inbox item and can attach recent session artifacts", async () => {
    const id = await seedProject("转交项目");
    const session = await json<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      }),
    );
    const rel = `handoff-note-${session.id.slice(-6)}.md`;
    const abs = resolve(PROJECT_ROOT, "sample-workspace", rel);
    await writeFile(abs, "handoff body\n", "utf8");
    session.artifacts = [{ path: rel, action: "created", updatedAt: nowIso() }];
    await saveSession(session);

    try {
    const missing = await app.request(`/api/projects/${id}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const unknown = await app.request(`/api/projects/${id}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_nope" }),
    });
    expect(unknown.status).toBe(404);

    const created = await app.request(`/api/projects/${id}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        note: "请从 brief 接着做。",
        attachRecentArtifacts: true,
      }),
    });
    expect(created.status).toBe(201);
    const body = await json<{
      inboxItem: { kind: string; body: string; sessionId?: string; assetIds?: string[] };
      attached: Array<{ artifactPath: string; asset: { sourceSessionId?: string; sourceArtifactPath?: string } }>;
    }>(created);
    expect(body.inboxItem.kind).toBe("handoff");
    expect(body.inboxItem.sessionId).toBe(session.id);
    expect(body.inboxItem.body).toContain("请从 brief 接着做");
    expect(body.inboxItem.body).toContain(rel);
    expect(body.attached).toHaveLength(1);
    expect(body.attached[0]?.artifactPath).toBe(rel);
    expect(body.attached[0]?.asset.sourceSessionId).toBe(session.id);
    expect(body.attached[0]?.asset.sourceArtifactPath).toBe(rel);
    expect(body.inboxItem.assetIds).toHaveLength(1);

    const inbox = await json<{ items: Array<{ kind: string; assetIds?: string[] }> }>(
      await app.request("/api/inbox"),
    );
    expect(inbox.items.some((i) => i.kind === "handoff" && (i.assetIds?.length ?? 0) > 0)).toBe(true);

    const project = await json<{
      assets: Array<{ filename: string; sourceSessionId?: string }>;
      messages: Array<{ kind: string }>;
    }>(await app.request(`/api/projects/${id}`));
    expect(project.assets.some((a) => a.filename === rel)).toBe(true);
    expect(project.messages.some((m) => m.kind === "handoff")).toBe(true);
    } finally {
      await unlink(abs).catch(() => undefined);
    }
  });

  it("refuses attaching artifacts from a session bound to another project", async () => {
    const a = await seedProject("项目甲");
    const b = await seedProject("项目乙");
    const session = await json<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: a }),
      }),
    );
    const rejected = await app.request(`/api/projects/${b}/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        attachRecentArtifacts: true,
      }),
    });
    expect(rejected.status).toBe(400);
    expect((await json<{ error: string }>(rejected)).error).toContain("not bound");
  });
});
