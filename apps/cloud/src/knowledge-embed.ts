import { normalize } from "./knowledge-text.ts";

/**
 * Optional embeddings for hybrid retrieval: any OpenAI-compatible `/embeddings` endpoint
 * (EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY; EMBEDDINGS_DIMENSIONS optional).
 * Disabled when unset; the knowledge base then uses lexical BM25 only.
 */
export const embeddingsEnabled = () => Boolean(process.env.EMBEDDINGS_BASE_URL && process.env.EMBEDDINGS_MODEL && process.env.EMBEDDINGS_API_KEY);
export const embeddingModel = () => (embeddingsEnabled() ? process.env.EMBEDDINGS_MODEL! : undefined);
const BATCH = 16;

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (!embeddingsEnabled()) throw Error("未配置嵌入模型");
  const out: number[][] = [];
  const base = process.env.EMBEDDINGS_BASE_URL!.replace(/\/+$/, "");
  const dimensions = Number(process.env.EMBEDDINGS_DIMENSIONS) || undefined;
  for (let i = 0; i < texts.length; i += BATCH) {
    const input = texts.slice(i, i + BATCH).map((t) => t.slice(0, 2000));
    const r = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EMBEDDINGS_API_KEY}` },
      body: JSON.stringify({ model: process.env.EMBEDDINGS_MODEL, input, ...(dimensions ? { dimensions } : {}) }),
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
    if (!r.ok) throw Error(`嵌入模型返回 HTTP ${r.status}`);
    const body = (await r.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== input.length || data.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) throw Error("嵌入模型响应无效");
    out.push(...data.map((d) => normalize(d.embedding)));
  }
  return out;
}
