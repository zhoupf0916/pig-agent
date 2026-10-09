/** F7 parallel subtasks: cloud runs only, never inside a child. Executed by the control plane. */
export const PARALLEL_TOOL = "spawn_parallel";
export const parallelToolDefinition = {
  type: "function" as const,
  function: {
    name: PARALLEL_TOOL,
    description:
      "把一批相互独立、每项工作量都较大的同类任务拆成并行子任务（map-reduce）。每项在独立上下文中执行，可读取当前工作区的副本和项目知识库，但不能联网、不会请求用户审批、对文件的修改不会保留。全部结束后你会收到每项结果（完整结果另存为成果文件），再据此汇总；这一轮不要同时调用其他工具。\n" +
      "何时使用（同时满足）：至少约 4 项；每项需要多次工具调用（读多个文件、检索知识库、分析数据），或每项输出较长（大约一段以上）；放在同一个上下文里逐项做会让上下文过长。\n" +
      "何时不要使用：每项一句话就能回答（解释词语、翻译短句、分类、打标签、简单计算）——直接在一次回答里逐项完成更快也更便宜；项数少于 4；各项互相依赖或需要先后顺序；需要联网、写文件或用户审批。\n" +
      "原因：每个子任务要单独排队、单独加载完整系统提示，并行本身有固定开销（实测 8 个一句话小项：并行约 15 秒、约 3.4 倍费用，单次直接回答约 5 秒）。",
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
