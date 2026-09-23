# 扩展与 MCP

## 使用路径

- Web：设置 → 扩展与 MCP。桌面：设置 → 插件。
- 发现扩展 → 查看内容 → 安装 → 已安装 → 启用。在新任务的专家/技能选择器中选择所需内容；安装不等于自动向所有任务注入。
- 五个内置包：编码质量、文档写作、数据分析、资料研究、故障排查，每个包含一位专家、一项技能。正文包含输入、步骤、交付与验证要求，可先阅读。
- 停用后不再出现在新任务选择里；移除前须停用。已有任务保留当时的上下文。
- 桌面支持导入原有 `pig-plugin-v1` JSON；云端当前只安装内置目录，不支持上传执行脚本、第三方二进制或自动安装依赖。

## 连接 MCP

1. 添加连接，填写名称、完整 HTTP(S) MCP 地址、超时与可选 Bearer 凭据。
2. 保存后默认未启用。测试连接会握手并列出工具，不调用工具。
3. 确认工具及服务器可信后启用。修改后立即持久化；留空凭据保留原值，勾选清除才会清除。
4. Pig 运行时会加载启用的工具。每次调用都暂停等待批准，自动执行档和远端声明的 `readOnlyHint` 都不能跳过审批。
5. 审批显示外部目标和输入；修改、停用或删除连接会使旧审批失效。

客户端使用 `@modelcontextprotocol/sdk` 1.30.0。支持 Streamable HTTP（JSON 和 SSE 响应）、initialize、tools/list、tools/call、会话终止；不是完整 MCP 服务端。stdio、旧版 SSE transport、OAuth、resources、prompts、分页发现和变更订阅暂未实现。本期挂载到 Pig 运行时；独立 Codex 后端不桥接这些连接。

当前每个服务读取第一页最多 40 个工具，schema 最大 8000 字符，调用结果最大 8000 字符；不兼容模型名称/长度限制的工具会显示未挂载原因，不截断名字后调用另一个工具。超时 500–120000 毫秒，默认 15000 毫秒，包含握手、发现或调用过程。建议只启用当前任务需要的少量服务。

## 执行位置、权限与秘密

MCP 工具在目标服务执行，**不受这台电脑或 Runner 的原生沙箱约束**。批准不会打开命令的任意网络访问。拒绝或审批前取消不调用外部工具；调用开始后取消会关闭请求，但不能回滚远端已经发生的副作用。

桌面凭据由 Electron 系统保险箱加密保存；普通本机开发服务没有保险箱时拒绝保存 MCP 凭据，可测试无凭据本机服务。云端配置按账号存于 PostgreSQL，凭据使用控制面 ENCRYPTION_KEY 加密，Runner 仅持有任务工具描述、目标版本与短期执行身份。GET、工具发现和结果会清理已配置凭据的直接回显；不承诺识别恶意服务编码后的秘密。

云端普通账号拒绝私网、loopback、组播、元数据地址和重定向；连接固定到校验后的 DNS 地址。管理员也默认同样限制，只有控制面配置 `MCP_ENDPOINT_ALLOWLIST` 的精确地址允许管理员连接内网（元数据仍禁止）。列表用逗号分隔，所有控制面实例需保持一致。不要将该选项作为普通用户的通用内网代理。

协同项目默认不加载私人 MCP，调用端也再次拒绝；禁用账号、Runner、失去项目权限或租约过期会停止外部请求。禁止网络的任务不发现/调用 MCP。

每个云端消费过的审批只能登记一次调用。登记后进程故障可能造成“没有调用”或“结果未知”，不会自动重放；这不是 exactly-once。需要重试时重新发起任务并审查外部实际状态。外部服务的幂等语义由该服务负责。

## 本地复验（无真实模型费用）

需要 Docker Desktop、Node 24 与依赖已安装。只使用独立 `pig-agent-cluster`，不操作普通 :8890 数据库。

```bash
pnpm cluster:up
# 增加仅供验收的 MCP 服务，并给两个控制面配置精确测试地址
# 改代码后先 pnpm cloud:build，再在下面命令加 --build

docker compose --env-file data/cluster-local/stack.env \
  -f infra/cluster/compose.yml -f infra/cluster/mcp-fixture.compose.yml \
  up -d --wait

docker compose --env-file data/cluster-local/stack.env \
  -f infra/cluster/compose.yml exec -T control \
  nginx -s reload -c /etc/pig-cluster/nginx.conf

node scripts/smoke-ecosystem.mjs
```

脚本创建两位专用测试账号，仅在 :8892/8894 发起模拟任务；测试凭据不打印，账号文件以 0600 保存到忽略的 `data/ecosystem-review/accounts.json`。检查并发安装、账号隔离、真实 Runner 调用、审批/重复批准/拒绝/取消、配置变更和超时。每次结束停用本次创建的 MCP 连接，保留任务记录及 `data/ecosystem-review/cloud-acceptance.json`。不要在这个验收集群启用真实模型渠道。

测试服务仅改变内存计数，不写工作区。桌面可用 `http://127.0.0.1:9910/mcp` 与脚本中的合成 fixture 凭据测试保险箱；无凭据入口 `/mcp-open`。普通模型聊天可连接 `http://127.0.0.1:9910/v1`，模型名任意，提示 `[MCP_ACCEPTANCE:write_marker]` 会请求工具。该提示只在模拟模型生效。

## 排障

- 连接被拒绝：核对账号角色、目标地址、公网 DNS 与管理员的精确 allowlist；不要关闭 SSRF 校验。
- 发现成功但未调用：检查是否启用、任务是否禁止网络、是否协同项目、审批是否仍待处理，以及工具是否符合模型命名/schema 限制。
- 配置已变化：旧审批失效是预期行为，重新发起调用；不要手工改审批记录。
- `Connection closed`：核对超时与外部服务日志，先确认远端是否产生副作用，再决定是否重新调用。
- 凭据与版本不一致：重新保存该连接；系统保险箱不可用时先修复系统密钥存储，不能降级明文。
- 控制面重建后 :8892 返回 502：等待实例健康，再执行上面的 Nginx reload。

本次实测证据见 [实施与验收记录](ecosystem-mcp-implementation-2026-09-23.md)，截图位于 `docs/evidence/ecosystem-mcp-2026-09-23/`。
