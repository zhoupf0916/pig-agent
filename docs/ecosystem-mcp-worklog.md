# 生态扩展与 MCP 进度

SDK：`@modelcontextprotocol/sdk@1.30.0`，传输 `streamable-http`。不宣称 stdio、OAuth、resources 或 prompts。

## 协议

- 自定义 fetch 合并截止信号和 SDK 自己的 abort signal。DNS、initialize、listTools、terminateSession 都受 `timeoutMs` 约束。
- `check-timeout.mjs`：500ms 配置在约 507ms 结束，不再挂到 2 秒。
- `check-streaming.mjs --product`：此前已通过（3 条持续流 + DELETE 204）。
- 配置的凭据按原文从工具说明、schema 文本、调用结果和上游错误中替换为 `[redacted]`，schema 的键和类型保留。
- `check-secret-redaction.mjs`：`descriptionRedacted` 与 `toolResultRedacted` 均为 true。
- 默认拒绝组播 `224.0.0.1`、广播 `255.255.255.255` 和 NAT64 元数据 `64:ff9b::a9fe:a9fe`。

## MCP 链路

- 本机配置在 `mcp-servers.json`，凭据只进桌面保险箱的 `mcpSecrets`。保存设置不会清掉它。GET 和磁盘配置不回显凭据。
- 本机任务加载已启用服务的工具；工作台批准后按当时的地址和凭据版本调用一次。地址变化、停用或删除后，旧审批不会再调用。
- 云端按用户保存加密凭据。运行器只拿到工具定义和目标版本，经网关让控制面代为调用；凭据不进入运行器。
- 普通租户不能连接 loopback、私网、组播或元数据。管理员精确 endpoint allowlist 只放行名单里的那一个地址，仍然拒绝元数据，也不对普通租户生效。
- 界面组件是 `apps/web/src/components/McpPanel.tsx`（`local` / `cloud`）。插件目录和 ExtensionsPanel 由另一条改动接入，这里不改那些文件。

## 尚未在本轮代跑

- 没有改 8890，没有重建 8892，没有提交。
- 云端真实 fixture 容器验收仍应使用单独环境和 `MCP_ENDPOINT_ALLOWLIST`，而不是给租户开放私网。


## 集成方后续验收

上述“尚未代跑”为 Cursor 交接时的状态。之后已由 Codex 完成插件目录与 UI 集成，并修复审批路由、目标版本、租约/取消传播、共享项目边界、保险箱一致性等问题；实际重建隔离8892双控制面双Runner并完成25项MCP链路验证，Electron原生窗口完成安装、连接、重启和审批调用。最新结果统一见 [实施与验收记录](ecosystem-mcp-implementation-2026-09-23.md)。
