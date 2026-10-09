/** Project knowledge base search (cloud runs in a project). Executed by the control plane, read-only. */
export const KNOWLEDGE_TOOL = "knowledge_search";
export const knowledgeToolDefinition = {
  type: "function" as const,
  function: {
    name: KNOWLEDGE_TOOL,
    description:
      "检索当前项目知识库（用户上传到项目的文档）。回答涉及项目资料、规范、产品或内部信息时先检索；可换关键词多次检索。结果带 [K1](#knowledge:…) 形式的引用链接，回答中引用资料的句子后必须附上对应链接；资料中没有就如实说明，不要编造。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "检索词或问题，尽量使用资料中可能出现的关键词" },
        k: { type: "integer", minimum: 1, maximum: 10, description: "返回段落数，默认 5" },
      },
      required: ["query"],
    },
  },
};
