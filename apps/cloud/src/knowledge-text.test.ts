import { describe, expect, it } from "vitest";
import { bm25, chunkText, CHUNK_MAX, dot, normalize, rrf, termText, tokenize, tsQuery } from "./knowledge-text.ts";

describe("tokenize", () => {
  it("indexes Han text as bigrams and Latin words whole", () => {
    expect(tokenize("对象存储 MinIO v2.1")).toEqual(["对象", "象存", "存储", "minio", "v2", "1", "v2.1"]);
  });
  it("drops question filler and particles from queries", () => {
    expect(tokenize("什么是对象存储的模式？", { query: true })).toEqual(["对象", "象存", "存储", "模式"]);
    expect(tsQuery("什么是 RRF")).toBe("'rrf'");
    expect(tsQuery("？？")).toBeUndefined();
  });
  it("produces tsquery-safe terms", () => {
    expect(termText("it's a 'test' & | ! (x)")).not.toMatch(/['&|!()]/);
  });
});

describe("chunkText", () => {
  const md = "# 手册\n\n简介。\n\n## 安装\n\n第一步下载。第二步运行。\n\n| 参数 | 默认 |\n| --- | --- |\n| port | 8890 |\n\n## 计费\n\n" + "按调用次数计费。".repeat(300);
  const chunks = chunkText(md);
  it("keeps heading paths and source offsets", () => {
    expect(chunks[0]).toMatchObject({ heading: "手册", content: "简介。" });
    const install = chunks.find((c) => c.heading === "手册 › 安装")!;
    expect(install.content).toContain("| port | 8890 |");
    for (const c of chunks) expect(md.slice(c.start, c.end).replace(/\s+/g, "")).toContain(c.content.replace(/\s+/g, "").slice(0, 20));
  });
  it("splits long sections on sentences within the size limit, with overlap", () => {
    const billing = chunks.filter((c) => c.heading === "手册 › 计费");
    expect(billing.length).toBeGreaterThan(2);
    for (const c of billing) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(billing[1]!.content.startsWith("按调用次数计费。")).toBe(true);
  });
  it("recognizes Chinese chapter headings", () => {
    expect(chunkText("第一章 总则\n内容甲\n\n第二章 附则\n内容乙").map((c) => c.heading)).toEqual(["第一章 总则", "第二章 附则"]);
  });
});

describe("ranking", () => {
  const docs = [
    { id: "a", heading: "安装", content: "下载安装包，然后运行安装程序。" },
    { id: "b", heading: "计费", content: "按调用次数计费，月底结算。" },
    { id: "c", heading: "简介", content: "这是一个安装在服务器上的系统。" },
  ];
  it("ranks heading matches and rarer terms higher", () => {
    expect(bm25("怎么安装", docs, { total: 3, avgLength: 0 }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(bm25("月底结算", docs, { total: 3, avgLength: 0 })[0]!.id).toBe("b");
  });
  it("fuses ranked lists with RRF", () => {
    const fused = rrf([["a", "b", "c"], ["c", "a"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"]);
    expect(fused[0]!.ranks).toEqual([1, 2]);
  });
  it("computes cosine on normalized vectors", () => {
    expect(dot(normalize([3, 4]), normalize([3, 4]))).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 2]))).toBeCloseTo(0);
  });
});
