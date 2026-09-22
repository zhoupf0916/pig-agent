# 阻塞、串行审批

## 执行契约

本地 Pig 的工具批次保存到 workbench.checkpoint。遇到第一项需要审批的操作，立即结束当前执行段，只有这一项进入 pending；不会执行或预览后续调用，也不会伪造成功的 tool 消息。批准操作在原工作区重新校验快照，执行并保存真实结果后自动恢复同批次剩余调用，直到下一项审批或任务结束。

拒绝和取消封闭整个当前批次；旧审批与 retry 返回 409，新的用户指令才可发起新任务段。批准接口使用会话互斥锁，重复点击/多端竞争只有一次成功。应用退出后的 checkpoint 和审批仍在磁盘；已标 applying/error 的不确定操作要求人工核对，绝不自动重放。已完成的 applied 操作可恢复 tool 结果且不会再执行。

这不是 exactly-once：进程在外部副作用与日志落盘之间崩溃时无法判定效果，因此保留 applying/error 并停止恢复。

云端保持 attempt token、run 行锁和租约 fencing。在现有逐项 await 的基础上，控制面拒绝第二个并发 pending 审批。新审批保存剩余执行预算，将 deadline 暂换为 30 分钟审批等待截止时间；批准/拒绝时恢复剩余预算。Worker 必须使用 heartbeat.deadlineAt，执行器同时暂停本地执行预算。租约心跳不会暂停。

## 已运行证据

命令：`pnpm exec vitest run apps/server/src/agent/runtime.test.ts apps/server/src/routes/workbench.test.ts`

2026-09-22：28 个测试通过；真实临时目录文件读写、模拟 HTTP SSE 模型，不产生付费推理：

- 两项写入和一项读取在同一模型批次中严格按审批顺序推进。
- 首项未批准时零 tool 结果、只有一个 pending，第二项甚至尚未 stage。
- 首项批准后恢复 checkpoint，不额外调用模型；双端批准第二项返回 200/409。
- 拒绝/取消后两个文件均未写入，旧批准与 retry 均被拒绝。
- 模拟进程在 applied journal 落盘、tool 消息保存前退出；重新读取状态后恢复实际结果而不重放，停到下一个审批。
- 保留文件变化冲突、中断 applying、费用上限、HTTP 单次权限及 undo 原有验证。

云端 deadline SQL 与 Worker 集成需要在整体环境部署后的端到端验收；本文件不以静态检查代替该验证。

## 云端实际集成验证

`node scripts/smoke-attachments.mjs` 在 8892 mock 双控制面/双 Runner 环境通过。pending 时查询 PostgreSQL：保存的剩余执行预算大于 0 且小于 300 秒，审批等待 deadline 距当前大于 1700 秒；真实 Runner 保持待批而未执行写入。批准后任务成功，重复批准 409；续聊拒绝后运行结束。证据：`data/attachment-evidence/report.json`。这是本地多实例与模拟模型验证，不涉及付费模型或生产容量推断。
