import type { ChatMessage } from "@pig-agent/contracts";
export type ContextEvalCase = {
  id: string;
  family: string;
  messages: ChatMessage[];
  budgetChars: number;
  required: string[];
  /** Exact structured outcomes. Never passed to the model. */
  answer: Record<string, string>;
  preserveAll?: boolean;
};
const m = (id: string, content: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ id, content, role, createdAt: "2026-09-26T00:00:00Z" });
/** 10 scenario families × 3 history lengths; synthetic probes, not 30 independent real tasks. */
export function contextCases(): ContextEvalCase[] {
  return [50, 75, 100].flatMap(rounds => {
    const noise = () => Array.from({ length: rounds }, (_, i) => m(`noise-${i}`, `第${i}轮无关运行日志。` + "处理临时缓存，无需行动。".repeat(70), "assistant"));
    const wrap = (family: string, early: ChatMessage[], question: string, answer: Record<string, string>, required = Object.values(answer)): ContextEvalCase => ({
      id: `${family}-${rounds}`, family, budgetChars: 6000,
      messages: [...early, ...noise(), m("now", question)], required, answer,
    });
    return [
      wrap("goal", [m("goal", "目标：交付季度销售报告，最终文件名 quarterly.csv，不得改锁文件。")], '返回 JSON {"file":"最终文件名"}', { file: "quarterly.csv" }),
      wrap("multiple-corrections", [m("goal", "部署服务。" + "最初背景。".repeat(400)), m("fix-region", "更正：区域只能是上海。"), m("fix-env", "更正：部署环境只能是staging，禁止写production。")], '返回 JSON {"region":"区域","environment":"环境"}', { region: "上海", environment: "staging" }),
      wrap("english-correction", [m("goal", "Prepare a deployment." + "Initial discussion. ".repeat(120)), m("fix", "Correction: use release-v9, not release-v8.")], 'Return JSON {"release":"required version"}', { release: "release-v9" }),
      wrap("middle-evidence", [m("goal", "查阅发票历史。"), m("invoice", "无关开头。".repeat(900) + " invoice-77 total=391 " + "无关末尾。".repeat(900), "assistant")], '查找 INVOICE-77，返回 JSON {"total":"数值"}', { total: "391" }, ["total=391"]),
      wrap("chinese-retrieval", [m("goal", "查询归档记录。"), m("archive", "无关开头。".repeat(900) + "蓝鲸账单金额为621元" + "无关末尾。".repeat(900), "assistant")], '蓝鲸账单的金额是什么？返回 JSON {"total":"数字"}', { total: "621" }, ["金额为621元"]),
      wrap("plan", [m("goal", "发布流程核对。"), { ...m("plan", "", "assistant"), toolCalls: [{ id: "plan-call", name: "update_plan", arguments: '{"next":"verify-schema"}' }] }, { ...m("plan-result", "计划已更新", "tool"), toolCallId: "plan-call" }], '返回 JSON {"next":"计划中的下一步"}', { next: "verify-schema" }),
      wrap("historical-approval", [m("goal", "以前的批准不能重复使用。"), { ...m("call", "", "assistant"), toolCalls: [{ id: "write", name: "write_file", arguments: "{}" }] }, { ...m("approved", "已批准写入 report.md", "tool"), toolCallId: "write" }], '根据审批边界，旧批准能否授权新的写入？返回 JSON {"reuse":"yes或no"}', { reuse: "no" }, ["不能当作当前批准"]),
      wrap("carried-context", [{ ...m("context-compact", "历史目标：交付匿名数据报告。"), synthetic: "context-compact" }, m("fix", "更正：输出格式必须为parquet。")], '返回 JSON {"format":"所需格式"}', { format: "parquet" }),
      wrap("later-current", [m("goal", "最初要求HTML。"), m("fix", "更正：改为Markdown。")], '再更正：最终只输出PDF。返回 JSON {"format":"最新格式"}', { format: "PDF" }),
      { id: `short-history-${rounds}`, family: "short-history", budgetChars: 4000, preserveAll: true,
        messages: [m("goal", "这是一段完整背景。".repeat(170)), m("answer", "这是一次完整答复。".repeat(170), "assistant"), m("now", '返回 JSON {"status":"ok"}')],
        required: [], answer: { status: "ok" } },
    ];
  });
}
