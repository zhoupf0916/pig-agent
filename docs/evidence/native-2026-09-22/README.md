# 本地原生沙箱切换后的回归证据

环境：macOS Docker Desktop 作为基础设施，8892 双控制面/双 Runner；任务在 Runner 内使用原生 Bubblewrap，不创建任务 Docker 容器。模型为 mock，无付费模型调用。

- `finish-fault.json`：真实原生 Runner 经授权故障代理，成功结果第一次 finish 前 503、提交后响应丢失，均重试同一结果并 succeeded；成果只落一次，outbox 收到确认后清空。复现 `node scripts/smoke-completion-delivery.mjs`。
- `completion-fencing.json`：双控制面并发 finish、finish/取消、代次注册重放等 5 个协议验证。复现 `node scripts/smoke-completion-fencing.mjs`。
- `artifact-source.json` 及同名桌面/手机截图：真实本地隔离 review server 8803 与两轮远端任务，缺失本地文件/同名不同内容/切换远端版本/显式导入审批均通过；远端预览没有调用本地 workspace/file，页面无 JS 错误。复现 `node scripts/smoke-native-artifact-provenance.mjs`，自动停止隔离服务器并恢复同名测试文件。
- `attachments.json`：9 项真实附件与审批预算验证，详见 `docs/attachments-2026-09-22.md`。

上述脚本仅使用 `data/cluster-local/stack.env` 中本地测试凭据，证据不含凭据。原件使用本地生成的测试文档。
