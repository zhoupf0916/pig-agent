/**
 * Difficulty-based model routing.
 *
 * Enabled when PIG_ROUTER_FAST_MODEL and/or PIG_ROUTER_STRONG_MODEL are set (otherwise every
 * call uses settings.llmModel). The tier is decided once per user turn — prompt caches are
 * per model, so flip-flopping inside a turn would throw the cache away — and only escalates
 * (fast → strong) after tool failures, never de-escalates mid-turn.
 */
export type Tier = "fast" | "strong";
export type Route = { model: string; tier: Tier; reason: string };
export type RouterConfig = { fast?: string; strong?: string };

const HARD = /(重构|架构|设计|方案|为什么|原因|排查|调试|debug|bug|优化|性能|算法|证明|推理|分析.*(根因|原因)|refactor|architecture|root cause|optimi[sz]e|race|并发|安全漏洞|迁移)/i;
const EASY = /^(列出|列一下|看看|读一下|打开|有哪些|多少个|统计|总结一下|翻译|改成|重命名|创建|新建|写一个|list|show|read|open|count|rename|create)/i;

export function routerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  return { fast: env.PIG_ROUTER_FAST_MODEL?.trim() || undefined, strong: env.PIG_ROUTER_STRONG_MODEL?.trim() || undefined };
}

export function classifyDifficulty(userText: string, signals: { attachments?: number; priorToolErrors?: number } = {}): { tier: Tier; reason: string } {
  const t = userText.trim();
  if ((signals.priorToolErrors ?? 0) > 0) return { tier: "strong", reason: "上一轮有工具失败" };
  if (HARD.test(t)) return { tier: "strong", reason: "包含复杂任务关键词" };
  if (t.length > 600) return { tier: "strong", reason: "请求较长" };
  if ((t.match(/\n\s*[-*\d]+[.、)]/g)?.length ?? 0) >= 4) return { tier: "strong", reason: "多步骤需求" };
  if (EASY.test(t) || t.length < 60) return { tier: "fast", reason: "简单/短请求" };
  return { tier: "strong", reason: "默认" };
}

export class ModelRouter {
  private tier: Tier;
  private reason: string;
  constructor(private base: string, private cfg: RouterConfig, userText: string, signals: { priorToolErrors?: number } = {}) {
    const c = classifyDifficulty(userText, signals);
    this.tier = c.tier; this.reason = c.reason;
  }
  get enabled(): boolean { return Boolean(this.cfg.fast || this.cfg.strong); }
  /** Escalate for the rest of the turn (e.g. after a failed tool call or a large context). */
  escalate(reason: string): void { if (this.tier !== "strong") { this.tier = "strong"; this.reason = reason; } }
  current(): Route {
    if (!this.enabled) return { model: this.base, tier: "strong", reason: "未启用路由" };
    const model = this.tier === "fast" ? this.cfg.fast ?? this.base : this.cfg.strong ?? this.base;
    return { model, tier: this.tier, reason: this.reason };
  }
}
