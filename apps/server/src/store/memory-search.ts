/**
 * Hybrid memory retrieval: BM25 over CJK-bigram/latin-word tokens, optional dense
 * embeddings (any OpenAI-compatible /embeddings endpoint), fused with Reciprocal Rank
 * Fusion and a mild recency prior. Pure ranking; scope/expiry filtering stays in
 * selectInjectableMemory so authorization rules are unchanged.
 */
export type RankableNote = { id: string; text: string; tags?: string[]; updatedAt?: string };
export type Embedder = (texts: string[]) => Promise<number[][]>;

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "for", "我", "的", "了", "是"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9_][a-z0-9_.-]*/g) ?? []) if (!STOP.has(word) && word.length > 1) out.push(word);
  // CJK: overlapping bigrams of each contiguous CJK run (single chars for 1-char runs)
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) { if (!STOP.has(run)) out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export function bm25Scores(query: string, docs: string[], k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  const toks = docs.map(tokenize);
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length);
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  return toks.map((t) => {
    const tf = new Map<string, number>();
    for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term); if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * t.length / (avg || 1)));
    }
    return score;
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const rankOf = (scores: number[]) => {
  const order = scores.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
  const ranks = new Map<number, number>(); order.forEach(([, i], r) => ranks.set(i, r + 1)); return ranks;
};

/** Rank notes for a query. Notes with no lexical/semantic signal are dropped. */
export async function rankMemory<T extends RankableNote>(query: string, notes: T[], opts: { limit?: number; embed?: Embedder; now?: number; minCosine?: number } = {}): Promise<Array<T & { score: number; signals: string[] }>> {
  if (!query.trim() || !notes.length) return [];
  const docs = notes.map((n) => `${n.text} ${(n.tags ?? []).join(" ")}`);
  const lexical = rankOf(bm25Scores(query, docs));
  let dense = new Map<number, number>();
  if (opts.embed) {
    try {
      const [qv, ...dv] = await opts.embed([query, ...docs]);
      const sims = dv.map((v) => cosine(qv!, v));
      dense = rankOf(sims.map((s) => (s >= (opts.minCosine ?? 0.3) ? s : 0)));
    } catch { /* embedding provider unavailable: lexical only */ }
  }
  const now = opts.now ?? Date.now();
  const K = 60;
  const scored = notes.map((note, i) => {
    const signals: string[] = [];
    let score = 0;
    const l = lexical.get(i); if (l) { score += 1 / (K + l); signals.push("bm25"); }
    const d = dense.get(i); if (d) { score += 1 / (K + d); signals.push("embedding"); }
    if (!signals.length) return { ...note, score: 0, signals };
    const ageDays = note.updatedAt ? Math.max(0, (now - Date.parse(note.updatedAt)) / 86_400_000) : 365;
    score *= 1 + 0.2 * Math.exp(-ageDays / 30); // mild recency prior, never dominates relevance
    return { ...note, score, signals };
  });
  return scored.filter((n) => n.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit ?? 5);
}

/** OpenAI-compatible embeddings; enabled only when PIG_EMBEDDING_MODEL is set. */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | undefined {
  const model = env.PIG_EMBEDDING_MODEL?.trim();
  const base = env.PIG_EMBEDDING_BASE_URL?.trim();
  if (!model || !base) return undefined;
  const key = env.PIG_EMBEDDING_API_KEY?.trim();
  const cache = new Map<string, number[]>();
  return async (texts) => {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (missing.length) {
      const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model, input: missing }), signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`embeddings ${res.status}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
      for (const item of json.data) cache.set(missing[item.index]!, item.embedding);
    }
    return texts.map((t) => cache.get(t) ?? []);
  };
}
