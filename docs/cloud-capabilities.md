# 云端专家与技能

Web 专家/技能库直接使用控制面 API，不依赖桌面本机 `/api`。内置专家由共享的 contracts 数据模块提供，保持原有侦察、规划、实现和评审指令；内置技能从控制面镜像的 `/app/skills` 读取。内置内容只读。

用户创建、修改的专家和技能保存在 PostgreSQL `cloud_capabilities`，读取和更新均按当前账户过滤。即使知道其他用户的 ID，也不能读取、修改或选择其私人内容。技能正文是可复用工作步骤，不是安装可执行代码或授予权限。

接口：

- `GET/POST /v1/experts`、`GET/PATCH /v1/experts/:id`
- `GET/POST /v1/skills`、`GET/PATCH /v1/skills/:id`
- `POST /v1/resource-drafts`，输入 `{kind: "expert" | "skill", prompt}`，返回可编辑草稿；确认创建之前不保存。

一句话生成使用平台已配置的真实模型。每次生成在账户行锁下检查日额度，并在 `model_usage` 记账；禁用工具调用，90 秒超时、4000 输出 token、1MB 响应上限。未配置通道返回 503，界面仍可手动创建；不会用固定模板假装 AI 生成，也不会回显模型密钥或原始提供商错误。

新任务通过 `expertId` 和 `skillIds` 选择库中内容。控制面验证资源归属，合并专家引用与显式技能，生成最大 80000 字符的内部 `capabilityContext`，Runner 真正追加到模型的用户工作背景；请求不能直接传入该内部字段。专家/技能不会扩大容器、网络或审批权限。

同一成员继续时沿用会话已经保存的专家和技能快照，库中后续修改不悄悄改变当前会话。共享项目换成员发言时，旧成员的私人资源选择会清除，避免将其私有指令继续注入另一个用户的模型请求；此前已经公开到共享会话的回答不会被反向删除。私人记忆由独立的作用域规则处理。

验证：`pnpm exec vitest run apps/cloud/src/capabilities.test.ts apps/server/src/store/experts.test.ts`；真实控制面与容器验证使用 `node scripts/smoke-cloud-capabilities.mjs`。该脚本检查内置读取/只读、创建修改持久化、跨账户读取修改使用拒绝、选择后的执行上下文和真实 Docker 任务；模拟模式下 AI 草稿诚实返回未配置提示。生成质量不能由模拟执行结果推断。

2026-09-22 真实集群验证通过，证据：`docs/evidence/cloud-capabilities-2026-09-22/checks.json`。首次运行发现控制面镜像缺少技能目录导致 500，已修正 Dockerfile 将内置技能复制到控制面镜像后重新验收。数据库验证运行输入同时包含选定专家与技能的核验标记，真实 Runner 完成任务。该记录不宣称真实提供商草稿质量已验收。
