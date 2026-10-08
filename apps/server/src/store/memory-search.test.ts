import { describe, expect, it } from "vitest";
import { bm25Scores, rankMemory, tokenize } from "./memory-search.ts";

const day = 86_400_000;
const now = Date.parse("2026-10-08T00:00:00Z");
const notes = [
  { id: "n1", text: "用户偏好：提交信息使用中文，遵循 conventional commits", updatedAt: new Date(now - 90 * day).toISOString() },
  { id: "n2", text: "数据库是 PostgreSQL 16，连接池上限 20", updatedAt: new Date(now - 1 * day).toISOString() },
  { id: "n3", text: "周报模板放在 drafts/weekly.md", tags: ["周报"], updatedAt: new Date(now - 5 * day).toISOString() },
];

describe("hybrid memory search", () => {
  it("tokenizes CJK into bigrams and latin into words", () => {
    expect(tokenize("写周报 PostgreSQL")).toEqual(["postgresql", "写周", "周报"]);
  });
  it("bm25 prefers the note sharing rare terms", () => {
    const s = bm25Scores("postgresql 连接池", notes.map((n) => n.text));
    expect(s[1]).toBeGreaterThan(s[0]!);
  });
  it("ranks by relevance, drops unrelated notes, uses tags", async () => {
    const r = await rankMemory("帮我写这周的周报", notes, { now });
    expect(r.map((x) => x.id)).toEqual(["n3"]);
    expect((await rankMemory("commit 信息用什么语言", notes, { now }))[0]!.id).toBe("n1");
  });
  it("fuses dense embeddings when provided (semantic match without shared tokens)", async () => {
    const vec: Record<string, number[]> = { q: [1, 0], n1: [0, 1], n2: [0.9, 0.1], n3: [0, 1] };
    const embed = async (texts: string[]) => texts.map((t) => (t === "DB 配置？" ? vec.q! : t.startsWith("数据库") ? vec.n2! : vec.n1!));
    const r = await rankMemory("DB 配置？", notes, { now, embed });
    expect(r[0]!.id).toBe("n2");
    expect(r[0]!.signals).toContain("embedding");
  });
  it("falls back to lexical when the embedder fails", async () => {
    const r = await rankMemory("周报", notes, { now, embed: async () => { throw new Error("down"); } });
    expect(r[0]!.id).toBe("n3");
  });
});
