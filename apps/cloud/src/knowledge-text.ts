/**
 * Knowledge base text processing shared by ingestion, search and the offline RAG eval:
 * Chinese-aware tokenization (Han bigrams + Latin/digit words), structure-aware chunking,
 * exact BM25 over candidate chunks, and reciprocal rank fusion.
 */

const HAN = /\p{Script=Han}/u;
const STOP_WORDS = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "are", "be", "with", "what", "how", "which", "does", "do"]);
// Query-only: question phrases and particles split Han runs so no bigram straddles them.
const QUERY_SPLIT = /什么是|是什么|为什么|怎么样|怎么办|怎么|如何|哪些|哪个|有没有|是不是|是否|能否|可以|多少|多久|请问|一下|这个|那个|会不会|[的了吗呢吧啊呀么]/u;
const PARTICLES = new Set([..."的了吗呢吧啊呀么"]);

/** Search terms: lowercase Latin/digit words (len >= 2 or numeric) and overlapping Han bigrams. */
export function tokenize(text: string, opts: { query?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/gu)) {
    const s = m[0];
    if (HAN.test(s)) {
      for (const run of opts.query ? s.split(new RegExp(QUERY_SPLIT, "gu")) : [s]) {
        const chars = [...run];
        if (chars.length === 1) {
          if (!PARTICLES.has(chars[0]!) && !opts.query) out.push(chars[0]!);
          continue;
        }
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
      }
    } else {
      for (const w of s.split(/[._-]+/).concat(s.includes(".") || s.includes("-") || s.includes("_") ? [s] : [])) {
        if (!w || STOP_WORDS.has(w) || (w.length < 2 && !/^\d$/.test(w))) continue;
        out.push(w.length > 40 ? w.slice(0, 40) : w);
      }
    }
  }
  return out;
}

/** Space-joined tokens for `to_tsvector('simple', ...)` (tokens contain no tsquery syntax). */
export const termText = (text: string) => tokenize(text).join(" ");
/** OR-query for the GIN candidate filter, or undefined when the query has no searchable terms. */
export function tsQuery(query: string): string | undefined {
  const terms = [...new Set(tokenize(query, { query: true }))].slice(0, 64);
  return terms.length ? terms.map((t) => `'${t.replace(/'/g, "")}'`).join(" | ") : undefined;
}

export type Chunk = { ordinal: number; heading: string; content: string; start: number; end: number };
export const CHUNK_TARGET = 600;
export const CHUNK_MAX = 1000;
const OVERLAP = 120;

/**
 * Structure-aware chunking: sections by Markdown headings (# … ######) and Chinese chapter headings
 * (第…章/节), paragraphs packed up to ~600 chars, Markdown tables kept whole (up to 2× max), oversized
 * paragraphs split on sentence boundaries, and a sentence of overlap between consecutive chunks of a section.
 * `start`/`end` index the normalized text so citations can point back at the source passage.
 */
export function chunkText(raw: string): Chunk[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  const lines = text.split("\n");
  type Block = { text: string; start: number; end: number; table?: boolean };
  type Section = { heading: string; blocks: Block[] };
  const sections: Section[] = [{ heading: "", blocks: [] }];
  const path: string[] = [];
  let offset = 0;
  let para: Block | undefined;
  const flush = () => {
    if (para && para.text.trim()) sections.at(-1)!.blocks.push(para);
    para = undefined;
  };
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    const cn = md ? null : /^\s*(第[一二三四五六七八九十百零\d]+[章节部分篇])\s*(.{0,40})$/.exec(line);
    if (md || cn) {
      flush();
      const level = md ? md[1]!.length : 1;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = md ? md[2]!.trim() : `${cn![1]} ${cn![2]}`.trim();
      sections.push({ heading: path.filter(Boolean).join(" › "), blocks: [] });
      continue;
    }
    const isTable = /^\s*\|.*\|\s*$/.test(line);
    if (!line.trim()) {
      flush();
      continue;
    }
    if (para && Boolean(para.table) !== isTable) flush();
    if (para) {
      para.text += "\n" + line;
      para.end = start + line.length;
    } else para = { text: line, start, end: start + line.length, table: isTable };
  }
  flush();

  const chunks: Chunk[] = [];
  const emit = (heading: string, content: string, start: number, end: number) => {
    const body = content.trim();
    if (body) chunks.push({ ordinal: chunks.length, heading, content: body, start, end });
  };
  for (const section of sections) {
    // Split oversized prose blocks into sentence-sized pieces first.
    const pieces: Block[] = [];
    for (const b of section.blocks) {
      if (b.text.length <= CHUNK_MAX || (b.table && b.text.length <= CHUNK_MAX * 2)) {
        pieces.push(b);
        continue;
      }
      let at = 0;
      for (const s of b.text.match(/[^。！？!?；;\n]+[。！？!?；;]?\n?|\n/g) ?? [b.text]) {
        for (let i = 0; i < s.length; i += CHUNK_MAX) pieces.push({ text: s.slice(i, i + CHUNK_MAX), start: b.start + at + i, end: b.start + at + Math.min(s.length, i + CHUNK_MAX) });
        at += s.length;
      }
    }
    let buf = "";
    let bufStart = -1;
    let bufEnd = -1;
    for (const p of pieces) {
      if (buf && buf.length + p.text.length + 1 > (p.table ? CHUNK_MAX * 2 : CHUNK_TARGET) && buf.length >= CHUNK_TARGET / 3) {
        emit(section.heading, buf, bufStart, bufEnd);
        // Overlap: carry the last sentence (<= 120 chars) of prose into the next chunk.
        const tail = /[^。！？!?.\n]{1,120}[。！？!?.]?\s*$/.exec(buf)?.[0] ?? "";
        buf = !p.table && tail.length < buf.length && tail.length <= OVERLAP ? tail.trim() : "";
        bufStart = buf ? bufEnd - tail.length : -1;
      }
      buf = buf ? buf + (p.start === bufEnd ? "" : "\n") + p.text : p.text;
      if (bufStart < 0) bufStart = p.start;
      bufEnd = p.end;
    }
    if (buf) emit(section.heading, buf, bufStart, bufEnd);
  }
  return chunks;
}

/** Text that is indexed for a chunk: the heading path counts twice (headings are strong signals). */
export const indexedText = (c: { heading: string; content: string }) => (c.heading ? `${c.heading}\n${c.heading}\n` : "") + c.content;

export type Candidate = { id: string; heading: string; content: string };
/**
 * Exact Okapi BM25 (k1 = 1.2, b = 0.75) over candidates. Candidates must be every chunk that contains at
 * least one query term (the GIN filter) so document frequencies are exact; `total`/`avgLength` describe the
 * whole searchable corpus.
 */
export function bm25<T extends Candidate>(query: string, candidates: T[], corpus: { total: number; avgLength: number }): Array<T & { score: number }> {
  const terms = [...new Set(tokenize(query, { query: true }))];
  if (!terms.length || !candidates.length) return [];
  const docs = candidates.map((c) => {
    const tokens = tokenize(indexedText(c));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { c, tf, length: tokens.length };
  });
  const N = Math.max(corpus.total, candidates.length);
  const avg = corpus.avgLength > 0 ? corpus.avgLength : docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const idf = new Map(terms.map((t) => {
    const df = docs.reduce((n, d) => n + (d.tf.has(t) ? 1 : 0), 0);
    return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
  }));
  return docs
    .map(({ c, tf, length }) => {
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (f) score += idf.get(t)! * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * length) / avg)));
      }
      return { ...c, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Reciprocal rank fusion (k = 60) of ranked id lists. */
export function rrf(lists: string[][], k = 60): Array<{ id: string; score: number; ranks: number[] }> {
  const fused = new Map<string, { score: number; ranks: number[] }>();
  lists.forEach((list, li) =>
    list.forEach((id, rank) => {
      const e = fused.get(id) ?? { score: 0, ranks: lists.map(() => 0) };
      e.score += 1 / (k + rank + 1);
      e.ranks[li] = rank + 1;
      fused.set(id, e);
    }),
  );
  return [...fused].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.score - a.score);
}

/** Cosine similarity of two L2-normalized vectors. */
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!;
  return s;
};
export const normalize = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
