import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, embeddingsEnabled } from "./knowledge-embed.ts";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("embeddings client", () => {
  it("is disabled without configuration", async () => {
    delete process.env.EMBEDDINGS_BASE_URL;
    expect(embeddingsEnabled()).toBe(false);
    await expect(embed(["x"])).rejects.toThrow(/未配置/);
  });
  it("batches, orders by index and normalizes", async () => {
    Object.assign(process.env, { EMBEDDINGS_BASE_URL: "https://emb.test/v1/", EMBEDDINGS_MODEL: "m", EMBEDDINGS_API_KEY: "k" });
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, n: body.input.length, auth: (init.headers as any).Authorization });
      return Response.json({ data: body.input.map((_: string, i: number) => ({ index: body.input.length - 1 - i, embedding: [3, 4 + (body.input.length - 1 - i)] })).reverse() });
    });
    const out = await embed(Array.from({ length: 20 }, (_, i) => `t${i}`));
    expect(calls.map((c) => c.n)).toEqual([16, 4]);
    expect(calls[0].url).toBe("https://emb.test/v1/embeddings");
    expect(out).toHaveLength(20);
    expect(Math.hypot(...out[0]!)).toBeCloseTo(1);
  });
  it("rejects malformed responses", async () => {
    Object.assign(process.env, { EMBEDDINGS_BASE_URL: "https://emb.test/v1", EMBEDDINGS_MODEL: "m", EMBEDDINGS_API_KEY: "k" });
    vi.stubGlobal("fetch", async () => Response.json({ data: [] }));
    await expect(embed(["a"])).rejects.toThrow(/无效/);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    await expect(embed(["a"])).rejects.toThrow(/401/);
  });
});
