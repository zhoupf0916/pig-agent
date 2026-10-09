/** F7 parallel subtasks: cloud runs only, never inside a child. Executed by the control plane. */
export const PARALLEL_TOOL = "spawn_parallel";
export const parallelToolDefinition = {
  type: "function" as const,
  function: {
    name: PARALLEL_TOOL,
    description:
      "把一批相互独立的同类工作（例如逐个调研 10 家公司、逐个处理文件、逐条分析数据）拆成并行子任务。每项在独立上下文中执行，可读取当前工作区的副本和项目知识库，但不能联网、不会请求用户审批、对文件的修改不会保留。全部子任务结束后，你会收到每项的结果（完整结果另存为成果文件），再据此汇总。只在至少 2 项、且每项都能独立完成时使用；这一轮不要同时调用其他工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 2000 }, description: "每个子任务处理的一项内容，最多 20 项" },
        instruction: { type: "string", maxLength: 4000, description: "对每一项都适用的说明：要做什么、关注什么、输出什么" },
        output_schema: { type: "object", description: "可选：每项结果必须符合的 JSON Schema（支持 type/properties/required/items/enum/minimum/maximum/minLength/maxLength 等常用关键字）。不符合会自动重试一次。" },
        max_parallel: { type: "integer", minimum: 1, maximum: 5, description: "同时执行的子任务数，默认 3（还受账号并发限制）" },
      },
      required: ["items", "instruction"],
    },
  },
};

/** Thrown by the runtime after the parallel group is registered and a safe checkpoint saved. */
export class RunYield extends Error {
  constructor(readonly callId: string) {
    super("Run yielded while parallel subtasks execute");
    this.name = "RunYield";
  }
}
