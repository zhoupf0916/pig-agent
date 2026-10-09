# 项目知识库（F5）

项目成员可以把资料（文本、Markdown、CSV/JSON、PDF、DOCX，单个 ≤ 4 MiB）上传到项目知识库。项目内的云端任务会获得 `knowledge_search` 工具，回答时引用原文；Web 端点击引用即可查看原文段落。

## 流程

1. **上传** `POST /v1/projects/:id/knowledge {name, data(base64)}`：需要项目编辑权限；同一项目内相同内容（SHA-256）去重；每个项目最多 200 个文件、50 MiB、20 000 个片段。原文件按 `STORAGE_MODE` 存放（见 [object-storage.md](object-storage.md)），与附件一致。
2. **摄取**（cloud 内的后台队列，`FOR UPDATE SKIP LOCKED`，多实例安全，失败自动重试最多 3 次，处理超过 10 分钟的视为卡住并重新领取）：
   - 解析：复用附件解析（PDF 用 `pdftotext` 前 100 页，DOCX 抽正文），在资源受限的子进程中执行；
   - 结构化切块：按 Markdown 标题和「第…章/节」划分章节，段落合并到约 600 字（上限 1000），表格整块保留，超长段落按句子切分，相邻片段重叠一句；每个片段记录标题路径和在原文中的位置；
   - 索引：中文按相邻两字（bigram）、英文/数字按词，写入 `tsvector('simple')`，标题权重为 A；配置了嵌入模型时同时写入归一化向量（`real[]`）。
   - 重试是幂等的：先删除该文档已有片段再写入。
3. **检索** `POST /v1/projects/:id/knowledge/search {query, k}`：
   - 关键词：GIN 索引取出包含任一查询词的候选（最多 2000），在应用层计算精确 BM25（k1 = 1.2，b = 0.75，标题计两次）；查询中的疑问词和语气词（如「什么是」「如何」「的」）不参与匹配。
   - 向量（可选）：项目内全部向量做余弦相似度（向量已归一化，20 000 片段以内直接计算）。
   - 融合：RRF（k = 60），返回每条结果在两路中的名次。
4. **引用**：工具输出带 `[K1](#knowledge:chunk_…)` 链接，模型被要求在引用资料的句子后附上；`GET /v1/knowledge/chunks/:id` 返回片段及前后各一段，权限按项目校验。

## 权限

- 读（列表、检索、引用、下载）：`project_access(project, user, false)`；写（上传、删除、重新处理）：`project_access(project, user, true)`。非成员一律 404/403。
- 工具调用走网关 `/knowledge/search`，用运行令牌在控制面换出任务所属项目和发起人，按发起人的权限检索。
- 资料内容在工具输出中被标注为不可信数据而非指令。

## 嵌入模型（可选）

DeepSeek 目前没有嵌入接口，默认只用关键词检索。配置任一 OpenAI 兼容的 `/embeddings` 接口即启用混合检索：

| 变量 | 说明 |
| --- | --- |
| `EMBEDDINGS_BASE_URL` | 例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`、`https://api.siliconflow.cn/v1` |
| `EMBEDDINGS_MODEL` | 例如 `text-embedding-v3`、`BAAI/bge-m3` |
| `EMBEDDINGS_API_KEY` | 写入 stack.env，不进仓库 |
| `EMBEDDINGS_DIMENSIONS` | 可选 |

启用后对已有文档点「重新处理」即可补算向量。没有使用 pgvector：生产库是 `postgres:17-alpine`，换成带扩展的镜像需要单独评估（libc/排序规则不同可能影响已有索引）；在当前规模下暴力计算足够。

## 评测

`pnpm eval:rag`（CI 门禁，recall@5 ≥ 90%）：在 `evals/rag/corpus`（9 篇项目文档的冻结副本）上用生产切块与排序回答 20 个改写过的问题，命中定义为前 k 条中有期望文档的期望章节。

| 方案 | 单元数 | recall@1 | recall@3 | recall@5 | MRR |
| --- | --- | --- | --- | --- | --- |
| 朴素基线（1000 字定长窗口 + 单字匹配） | 31 | 60% | 80% | 90% | 0.728 |
| 生产方案（结构化切块 + bigram BM25 + 标题加权） | 64 | 95% | 100% | 100% | 0.975 |

问题由开发者编写，规模小，仅用于防回归；答案正确率需要真实模型，见线上 e2e 的「知识库」检查。
