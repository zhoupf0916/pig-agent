# 可恢复执行与链路观测

目标：进程失联后从已确认的消息/工作区边界接续；工具结果不确定时停止自动重放。把排队、准备、模型、工具、审批和整体耗时分开，避免把阶段时间相加伪装端到端延迟。

设计：控制面 PostgreSQL 保存每个 run 的安全检查点和恢复次数，当前租约令牌约束检查点写入。每次模型调用前保存安全检查点；工具组执行前同步置为 unsafe，确认失败则不得执行。只有 safe 的失联任务自动重新排队，最多两次，保留原截止时间。取消、超时、审批中或工具执行中的不确定副作用不自动重放。新尝试更换令牌，旧令牌不能更新检查点或提交结果。消息与工作区一并保存，避免只恢复对话却丢掉文件。

不提供任意外部写入 exactly-once。safe 点前已完成的工具不会主动重新播放，但后续模型仍可能请求重复操作；外部业务 API 的幂等仍由工具实现负责。检查点超过体积上限时停止任务而不是跳过持久化继续执行。

验收：先失败测试覆盖过期凭据、unsafe 标记、取消/超时、恢复上限、截止时间不重置、旧事件不覆盖新尝试；实际进程故障与部署验证后补充证据。链路报告复用原有鉴权，只返回计数与耗时，不暴露输入/密钥。部署前备份、保留回滚镜像并检查活跃任务。

## 复现故障注入（隔离环境）

这是模拟模型、两个控制面与两个真实 Runner 的专用栈，不使用生产数据库、密钥或模型渠道。脚本将杀掉测试 Runner，项目名固定为 `pig-recovery`，不可用于生产任务。

```bash
pnpm cloud:build
mkdir -p data/recovery-test
node --input-type=module -e 'import {writeFileSync,existsSync} from "node:fs"; import {randomBytes} from "node:crypto"; const p="data/recovery-test/stack.env"; if(!existsSync(p)) writeFileSync(p,["DB_PASSWORD","ENCRYPTION_KEY","ADMIN_TOKEN","MEMBER_TOKEN","MEMBER2_TOKEN","WORKER_TOKEN"].map(k=>k+"="+randomBytes(32).toString("hex")).join("\n"),{mode:0o600});'
docker compose -p pig-recovery --env-file data/recovery-test/stack.env -f infra/cluster/compose.yml -f infra/recovery/compose.yml up -d --build --wait
node scripts/smoke-recovery.mjs
# 测试完停止隔离栈；不操作正式 pig-agent-cloud 项目
docker compose -p pig-recovery --env-file data/recovery-test/stack.env -f infra/cluster/compose.yml -f infra/recovery/compose.yml down
```

脚本检查实际产物内容、写入调用次数、跨节点接续、deadline 保持不变、审批中断不重放、取消后的检查点拒绝、两次恢复上限、过期截止时间。证据写入 `data/recovery-test/evidence.json`。本轮在腾讯云同机的独立 Docker 网络、独立数据库和独立凭据上运行；负载由模拟模型固定延时制造，不能作为真实模型容量指标。

## 观测口径

运行 ID 是关联主键，执行尝试具有独立 ID，事件键包含尝试随机 ID，避免新 Runner 的序列号从 1 开始覆盖旧事件。开发者接口复用原有 owner/project/admin 权限，仅汇总数字，不返回检查点正文。

排队、准备和整体经过使用同一个 PostgreSQL 时钟；模型、工具、审批、上下文及检查点耗时在各执行进程内用单调时钟测量。不同阶段有嵌套和并行，累计值不能相加等同于总时长。首字缺失、供应商 usage 缺失保持未知。旧尝试崩溃留下未闭合 span 或记录被截断时报告 partial，不能据此作精确成本结算。计费仍以模型网关账本为准。

整体经过从控制面接单到终态，**不包含浏览器网络往返或渲染耗时**。这里只提供分段诊断能力，没有声称响应速度提升；本轮未进行生产高并发压测。后续性能优化应以这些指标的分布和真实样本为依据。
