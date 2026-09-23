import type { ModelTariff, ModelTokenUsage } from "@pig-agent/contracts/cloud";
// Platform tariff, CNY per million tokens. Snapshot on every call.
export const defaultTariff: ModelTariff = { input: 2, cached: 0.04, output: 8 };
export function parseUsage(value: unknown): ModelTokenUsage | null {
  const u = value as Record<string, unknown> | null;
  if (!u) return null;
  const input = u.prompt_tokens,
    output = u.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    Number(input) < 0 ||
    Number(output) < 0
  )
    return null;
  const cached = Number(
    u.prompt_cache_hit_tokens ??
      (u.prompt_tokens_details as { cached_tokens?: number })?.cached_tokens ??
      0,
  );
  if (!Number.isSafeInteger(cached) || cached < 0) return null;
  return {
    input: Number(input),
    output: Number(output),
    cached: Math.min(cached, Number(input)),
  };
}
export function priceUsage(u: ModelTokenUsage, p: ModelTariff): number {
  return Math.ceil(
    (u.input - u.cached) * p.input + u.cached * p.cached + u.output * p.output,
  );
}
export function reserveCost(
  body: unknown,
  maxOutput: number,
  p: ModelTariff,
): number {
  // UTF-8 bytes overestimate text tokens; reserve extra for provider framing.
  return priceUsage(
    {
      input: Buffer.byteLength(JSON.stringify(body), "utf8") + 4096,
      cached: 0,
      output: maxOutput,
    },
    p,
  );
}
export const billingSchema = `
ALTER TABLE principals ADD COLUMN IF NOT EXISTS budget_micros bigint NOT NULL DEFAULT 2000000 CHECK(budget_micros>=0);
ALTER TABLE model_channels ADD COLUMN IF NOT EXISTS tariff jsonb NOT NULL DEFAULT '{"input":2,"cached":0.04,"output":8}';
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS reserved_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS charged_micros bigint;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS tariff jsonb;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS token_usage jsonb;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS settled_at timestamptz;
CREATE OR REPLACE FUNCTION reserve_model_budget(account_id text, task_id text, amount bigint, prices jsonb) RETURNS bigint AS $$
DECLARE lim bigint; used bigint; result bigint;
BEGIN
 SELECT budget_micros INTO lim FROM principals WHERE id=account_id AND enabled FOR UPDATE;
 IF lim IS NULL OR amount<0 THEN RAISE EXCEPTION '账号不可用'; END IF;
 SELECT COALESCE(sum(COALESCE(charged_micros,reserved_micros)),0) INTO used FROM model_usage WHERE owner_id=account_id;
 IF used+amount>lim THEN RAISE EXCEPTION '模型额度不足，请联系管理员增加预算'; END IF;
 INSERT INTO model_usage(owner_id,run_id,reserved_micros,tariff) VALUES(account_id,task_id,amount,prices) RETURNING id INTO result;
 RETURN result;
END; $$ LANGUAGE plpgsql;
`;
