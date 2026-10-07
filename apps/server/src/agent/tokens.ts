/**
 * Provider-agnostic token estimation.
 *
 * Budgets used to treat characters as tokens, which over-counts English/code ~3-4x
 * and under-counts nothing for CJK. This estimator approximates BPE tokenizers
 * (cl100k / DeepSeek): CJK ideographs ≈ 0.6 token each, other text ≈ 1 token per
 * 4 chars, plus a small per-message overhead. A per-run calibrator then scales the
 * estimate with the provider-reported `prompt_tokens` once available.
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
export const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const other = text.length - cjk;
  return Math.ceil(cjk * 0.6 + other / 4);
}

export type TokenizableMessage = { content: string; reasoningContent?: string; toolCalls?: unknown };

export function estimateMessagesTokens(messages: TokenizableMessage[]): number {
  return messages.reduce((n, m) => n + MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content) + estimateTokens(m.reasoningContent) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0), 0);
}

export function estimateToolSchemaTokens(...defs: unknown[]): number {
  return defs.reduce<number>((n, d) => n + (d ? estimateTokens(JSON.stringify(d)) : 0), 0);
}

/** Learns provider/heuristic ratio from reported usage; clamped to avoid wild swings. */
export class TokenCalibrator {
  private ratio = 1;
  private samples = 0;
  apply(estimate: number): number { return Math.ceil(estimate * this.ratio); }
  observe(estimate: number, reported: number): void {
    if (!(estimate > 0) || !(reported > 0) || !Number.isFinite(reported)) return;
    const observed = Math.min(2.5, Math.max(0.4, reported / estimate));
    this.samples += 1;
    // exponential moving average, first sample taken as-is
    this.ratio = this.samples === 1 ? observed : this.ratio * 0.7 + observed * 0.3;
  }
  get currentRatio(): number { return this.ratio; }
}
