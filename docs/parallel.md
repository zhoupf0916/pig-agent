# 并行子任务（F7，Wide Research 式 map-reduce）

云端任务可以调用 `spawn_parallel({ items[], instruction, output_schema?, max_parallel? })`，把一批相互独立的同类工作拆成子任务并行执行，全部结束后再汇总。

## 流程

1. Runner 经网关 `POST /children` 登记子任务组（按 `(父任务, callId)` 幂等，最多 20 项，`max_parallel` 1–5，默认 3）。
2. 运行时关闭同一轮其余工具调用（返回“未执行”），保存**安全检查点**，以 `{ waiting: { callId } }` 结束本次尝试。
3. 控制面把父任务设为 `waiting`：不计入活跃并发，**让出 Runner 槽位**（否则 4 个 Runner 可能都被等待中的父任务占满），并在同一事务里启动前 `max_parallel` 个子任务。
4. 子任务是普通排队任务：同一账号、同样的并发/额度/预算/重试（U3）规则。每项独立上下文，拿到父任务工作区副本（≤2 MB）和项目知识库，**禁止联网、不请求审批、不加载外部 MCP、不能再拆分**，文件修改不保留。
5. 每 3 秒以及每个子任务结束时推进任务组：收集最后一条回答；有 `output_schema` 时解析并校验 JSON，不符合则带错误说明**自动重试一次**；补齐并行度。
6. 全部结束后：完整结果写入父任务成果文件 `parallel/<callId>.json`，摘要（每项截断）作为工具结果追加到检查点并写入事件流，父任务重新排队，从检查点继续（`resumed_at`；执行期限重新计算，排队超时从恢复时刻起算）。

## 限制与保护

- 子任务模型调用总数上限：`12 × 项数`（最多 500）；超出或 30 分钟期限到达时取消剩余子任务，用已有结果恢复父任务。
- 取消父任务会取消所有子任务。
- 父任务等待期间，失败或取消的子任务可以在界面上单独重试。
- JSON Schema 只支持常用关键字（type/properties/required/additionalProperties/items/enum/const/minimum/maximum/minLength/maxLength/minItems/maxItems），不支持的关键字会在登记时报错，避免“看起来校验了其实没校验”。

## 接口与界面

- `GET /v1/runs/:id/children`：任务组、每项状态、尝试次数、结果预览、token 用量（输入/缓存命中/输出）。
- `POST /v1/runs/:id/children/:callId/:idx/retry`：父任务等待时重试单项。
- 会话页显示子任务网格（进度条、每项状态与预览、重试按钮）；任务状态显示“等待子任务”。
- 迁移 0009（只扩展）：`run_child_groups`、`run_children`、`runs.resumed_at`。
- 本地验收：`pnpm cloud:smoke:parallel`（模拟模型：扇出 3 项、观察到 waiting、无效 JSON 自动重试、父任务恢复汇总、取消父任务级联取消子任务）。
