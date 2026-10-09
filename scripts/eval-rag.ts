// F5 retrieval eval (offline, deterministic): chunk + index the frozen corpus with the production
// knowledge-text pipeline, ask 20 paraphrased questions, report recall@k / MRR and compare with a naive
// baseline (fixed 1000-char windows, character-unigram matching, no headings). CI gate: --min-recall5.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bm25, chunkText, tokenize, indexedText } from "../apps/cloud/src/knowledge-text.ts";

const root = join(import.meta.dirname, "..", "evals", "rag");
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const { questions } = JSON.parse(readFileSync(join(root, "questions.json"), "utf8")) as { questions: Array<{ q: string; doc: string; section: string }> };
const docs = readdirSync(join(root, "corpus")).filter((f) => f.endsWith(".md")).map((f) => ({ doc: f.replace(/\.md$/, ""), text: readFileSync(join(root, "corpus", f), "utf8") }));

type Row = { id: string; doc: string; heading: string; content: string };
// Production pipeline: structure-aware chunks, Han bigrams, heading-weighted BM25 over GIN-style candidates.
const chunks: Row[] = docs.flatMap((d) => chunkText(d.text).map((c) => ({ id: `${d.doc}#${c.ordinal}`, doc: d.doc, heading: c.heading, content: c.content })));
const avgLength = chunks.reduce((s, c) => s + tokenize(indexedText(c)).length, 0) / chunks.length;
function production(q: string) {
  const terms = new Set(tokenize(q, { query: true }));
  const candidates = chunks.filter((c) => tokenize(indexedText(c)).some((t) => terms.has(t)));
  return bm25(q, candidates, { total: chunks.length, avgLength });
}
// Naive baseline: 1000-char windows (no structure), score = number of query characters present.
const windows: Row[] = docs.flatMap((d) => {
  const out: Row[] = [];
  for (let i = 0; i < d.text.length; i += 1000) {
    const content = d.text.slice(i, i + 1000);
    // Heading of a window = last heading at or before its start (for scoring the hit only).
    const before = d.text.slice(0, i + 1).match(/^#{1,6} .+$/gm) ?? [];
    const inside = content.match(/^#{1,6} .+$/gm) ?? [];
    out.push({ id: `${d.doc}@${i}`, doc: d.doc, heading: [...before.slice(-1), ...inside].join(" | "), content });
  }
  return out;
});
function naive(q: string) {
  const chars = [...new Set([...q.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)))];
  return windows.map((w) => ({ ...w, score: chars.filter((ch) => w.content.toLowerCase().includes(ch)).length })).filter((w) => w.score > 0).sort((a, b) => b.score - a.score);
}

const sectionOf = (heading: string, section: string) => heading.toLowerCase().includes(section.toLowerCase());
function evaluate(name: string, search: (q: string) => Row[]) {
  const per = questions.map((t) => {
    const hits = search(t.q);
    const rank = hits.findIndex((h) => h.doc === t.doc && sectionOf(h.heading, t.section)) + 1;
    const docRank = hits.findIndex((h) => h.doc === t.doc) + 1;
    return { q: t.q, expected: `${t.doc} › ${t.section}`, rank, docRank, top: hits.slice(0, 3).map((h) => `${h.doc} › ${h.heading.slice(0, 40)}`) };
  });
  const at = (k: number) => per.filter((p) => p.rank > 0 && p.rank <= k).length / per.length;
  const summary = {
    name,
    units: name === "production" ? chunks.length : windows.length,
    recall1: at(1),
    recall3: at(3),
    recall5: at(5),
    docRecall5: per.filter((p) => p.docRank > 0 && p.docRank <= 5).length / per.length,
    mrr: per.reduce((s, p) => s + (p.rank ? 1 / p.rank : 0), 0) / per.length,
  };
  return { summary, per };
}

const prod = evaluate("production", production);
const base = evaluate("naive-baseline", naive);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
for (const r of [base, prod]) console.log(`${r.summary.name.padEnd(15)} units=${String(r.summary.units).padEnd(4)} recall@1=${pct(r.summary.recall1)} recall@3=${pct(r.summary.recall3)} recall@5=${pct(r.summary.recall5)} doc-recall@5=${pct(r.summary.docRecall5)} MRR=${r.summary.mrr.toFixed(3)}`);
for (const p of prod.per.filter((p) => !p.rank || p.rank > 5)) console.log(`  MISS ${p.q} (expected ${p.expected}; top: ${p.top.join(" / ")})`);
const out = opt("--out");
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ production: prod, baseline: base }, null, 2)); }
const min = Number(opt("--min-recall5") ?? NaN);
if (Number.isFinite(min) && prod.summary.recall5 < min) {
  console.error(`RAG gate failed: recall@5 ${pct(prod.summary.recall5)} < ${pct(min)}`);
  process.exit(1);
}
