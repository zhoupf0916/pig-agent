# 审批策略修复与真实执行验证

本次修复了“自动”选项的 `false` 被当成省略值、不同协作者继承上一作者自动执行同意、自动化界面不能保存独立策略的问题。

## 实际语义

- Web 的任务始终在远端容器运行。`requireApproval=true` 要求写入等需审批工具等待用户决定；显式 `false` 允许这类工具自动执行。未选择时采用账号默认，未配置账号默认要求审批。
- 网络授权独立于写入审批。自动写入不会把 `blocked` 改成可联网，也不会自动批准 `ask` 网络请求。
- 同一作者续聊保留任务策略；其他协作者续聊读取该协作者自己的账号策略，不继承上一作者的自动同意。
- 自动化保存自己的审批与网络策略。修改账号默认不会追溯修改计划；编辑计划会影响下一次执行，不修改已经创建的运行。
- 本机 Pig 才显示并接受 Pig 的审批和沙箱设置。Codex 使用自身权限体系，不显示无效的 Pig 档位；后端也拒绝向非 Pig 会话写入这类设置。

## 真实验证

环境：本地 Docker，隔离入口 `http://127.0.0.1:8892`，两个控制面与两个 Runner，模拟模型发出真实工具调用，由真实容器执行。未改动用户 `8890` 实例、模型或数据。使用独立测试账号，结束后禁用账号和计划，保留运行证据。

执行：`node scripts/smoke-execution-policy.mjs`。机器可读结果见 [checks.json](evidence/execution-policy-2026-09-22/checks.json)。

补充回归：`pnpm exec vitest run apps/cloud/src/execution-policy.test.ts apps/cloud/src/user-data.test.ts apps/cloud/src/conversation-state.test.ts apps/server/src/agent/runtime.test.ts apps/server/src/agent/cloud/runtime.test.ts`，5 个文件、34 项测试通过；`git diff --check` 通过。

通过的场景：

1. 无显式策略的任务等待审批。直接 `docker exec` 检查执行容器的 `/workspace/cloud-proof.txt` 不存在，再次检查仍不存在；批准后真实生成成果。
2. 拒绝审批后运行失败，无成果。
3. 显式自动模式实际写入成果，无审批记录；网络仍为禁止。
4. 自动模式的共享任务由另一成员续聊，实际进入该成员要求的审批，网络策略也采用该成员设置。
5. 自动化的显式自动模式保存、读取和账号默认修改后保持，立即执行无审批完成；编辑为审批模式后，下一次立即执行在写入前等待审批，容器中目标文件不存在。

这里验证的是应用层工具授权和执行策略，不能据此宣称容器不存在其他安全风险。模拟模型验证了授权链路，没有将其描述为真实提供商的推理能力验证。
