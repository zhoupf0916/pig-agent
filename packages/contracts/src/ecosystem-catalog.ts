import { CURATED_CATALOG } from "./curated-catalog.js";
import type { EcosystemPlugin } from "./ecosystem.ts";

function skill(id: string, name: string, description: string, body: string) {
  return { id, name, description, body };
}

function expert(id: string, name: string, description: string, instruction: string, skillIds: string[]) {
  return { id, name, description, instruction, skillIds };
}

const review = skill(
  "review-checklist",
  "代码审查清单",
  "按风险排序审查改动，并指出缺的验证。",
  [
    "触发：用户要求审查、找缺陷，或准备合并改动。",
    "输入：目标路径、改动范围、已有测试命令。缺了就先问，不要假设。",
    "步骤：1. 只读相关文件和测试。2. 按正确性、失败处理、安全边界、回归风险列问题。3. 每个问题给出文件路径和为什么重要。",
    "交付：按严重程度排序的审查清单，以及还没验证的部分。",
    "验证：清单中的路径都能在工作区找到；没有未读文件却声称已检查。",
  ].join("\n"),
);

const docs = skill(
  "doc-brief",
  "文档写作",
  "把零散材料整理成可核对的说明。",
  [
    "触发：用户要写说明、报告、变更记录或使用步骤。",
    "输入：读者、目的、必须保留的事实来源。",
    "步骤：1. 只使用读到的材料。2. 先写结论，再写步骤和限制。3. 缺信息时单独列出，不编造。",
    "交付：一份读者能按步骤执行或核对的 Markdown。",
    "验证：文中每个具体数字、路径和命令都能指回来源。",
  ].join("\n"),
);

const tables = skill(
  "table-analysis",
  "表格分析",
  "对小表做口径清楚的汇总，不把猜测当结果。",
  [
    "触发：用户给了表格、CSV 或一组数字，要比较、分组或找异常。",
    "输入：列含义、单位、时间范围。缺口径就停下来问。",
    "步骤：1. 确认列和空值。2. 给出计算式再给结果。3. 标出样本太小或列冲突的地方。",
    "交付：汇总表、计算过程和不能下结论的项。",
    "验证：用同一输入重算关键合计；对不上就说明差异。",
  ].join("\n"),
);

const sources = skill(
  "source-research",
  "资料研究",
  "围绕问题收集可引用的材料并标出缺口。",
  [
    "触发：用户要调研、比较方案或核对一个说法。",
    "输入：问题、时间范围、可接受的来源。",
    "步骤：1. 列出要回答的子问题。2. 只引用实际读到的内容。3. 区分事实、推断和未知。",
    "交付：带来源的结论，以及仍需确认的问题。",
    "验证：每条结论能指回具体材料；没有材料的判断标成推断。",
  ].join("\n"),
);

const incident = skill(
  "incident-triage",
  "故障排查",
  "从现象缩小到可复核的原因，不靠重启掩盖问题。",
  [
    "触发：用户描述失败、超时、报错或结果不对。",
    "输入：报错原文、发生时间、最近一次改动。",
    "步骤：1. 复述现象和已排除项。2. 读日志、配置和相关代码。3. 给出最小核验步骤，而不是一串猜测。",
    "交付：最可能的原因、支持证据、下一步验证。",
    "验证：验证步骤能由用户重复；未执行的检查标成未做。",
  ].join("\n"),
);

export const ECOSYSTEM_CATALOG: EcosystemPlugin[] = [
  ...CURATED_CATALOG,
  {
    id: "coding-quality",
    name: "编码质量",
    version: "1.0.0",
    description: "审查改动、标出风险，并要求用现有测试核对。",
    purpose: "在合并前找出行为、边界和验证缺口。",
    skills: [review],
    experts: [expert("quality-reviewer", "质量审查", "只做审查，不直接改产品代码。", "职责：按 review-checklist 审查。边界：不安装依赖，不扩大权限，不把未运行的测试说成已通过。发现必须写路径。", ["review-checklist"])],
  },
  {
    id: "doc-writing",
    name: "文档写作",
    version: "1.0.0",
    description: "把材料写成可核对的说明。",
    purpose: "给读者一份能执行或能核对的文档。",
    skills: [docs],
    experts: [expert("doc-editor", "文档编辑", "负责结构和事实核对。", "职责：按 doc-brief 写作。边界：不编造来源，不改与文档无关的代码。", ["doc-brief"])],
  },
  {
    id: "data-analysis",
    name: "数据分析",
    version: "1.0.0",
    description: "对小表做可复核的汇总。",
    purpose: "把表格问题回答清楚，并标出口径。",
    skills: [tables],
    experts: [expert("table-analyst", "表格分析", "只根据给出的表计算。", "职责：按 table-analysis 汇总。边界：缺单位或口径时停止追问，不把样本外的趋势说成结论。", ["table-analysis"])],
  },
  {
    id: "research",
    name: "资料研究",
    version: "1.0.0",
    description: "收集材料并区分事实和推断。",
    purpose: "回答调研问题，同时留下来源和缺口。",
    skills: [sources],
    experts: [expert("source-researcher", "研究助理", "负责带来源的简报。", "职责：按 source-research 整理。边界：不把推断写成事实，不访问未批准的外部工具。", ["source-research"])],
  },
  {
    id: "troubleshooting",
    name: "故障排查",
    version: "1.0.0",
    description: "从现象缩到可重复的核验。",
    purpose: "帮助定位失败原因，而不是盲目重试。",
    skills: [incident],
    experts: [expert("incident-lead", "排查负责人", "先取证再建议改动。", "职责：按 incident-triage 排查。边界：不删除现场，不把未执行的命令说成已运行。", ["incident-triage"])],
  },
];

export function catalogPlugin(id: string): EcosystemPlugin | undefined {
  return ECOSYSTEM_CATALOG.find((item) => item.id === id);
}
