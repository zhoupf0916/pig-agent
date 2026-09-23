# 生态扩展与 MCP 实施 / 验收

用户要求：内置实用 skill、专家、插件，并支持 MCP 协议。沿用 Cursor 实施、Codex 独立验收的协作方式。不覆盖已有工作、不提交推送、不使用真实付费模型批量测试。

## 当前基线

- skills/ 有 7 个 Markdown 技能；contracts 有 Scout/Plan/Implement/Review 四位编码专家。
- 本机插件仅支持 pig-plugin-v1 技能/专家包，导入后默认禁用；没有内置发现目录，DTO 在界面重复。
- 云端 capabilities.ts 管理每用户专家/技能，读取共用内置内容；没有完整插件入口。
- 未找到现有 MCP 客户端。现有执行链具备逐项审批、取消、原生沙箱和远端授权钩子，扩展不能绕过这些机制。

## 产品目标与取舍

1. 一份内置生态目录：覆盖编码质量、文档写作、数据分析、研究、故障排查。技能需有触发条件、输入、步骤、交付与验证；专家明确职责和边界；插件组合有实际用途的技能/专家，不能只列名称。保留已有 ID、用户修改和导入插件。
2. 本机与云端都能浏览内置插件、查看内容、一键安装、明确启停、卸载。默认不运行脚本、不下载依赖、不要求第三方账号；安装/启用不扩大权限。云端按用户隔离，不复用本机 JSON 存储。
3. MCP 是作为客户端连接外部 MCP server，而不是宣称把整个 Pig 变成 MCP server。第一版支持标准 Streamable HTTP，采用官方 SDK 做 initialize、tools/list、tools/call、会话关闭和取消。stdio/OAuth/完整 resources/prompts 不是本次默认承诺；只有完成真实实现和测试才开放入口，明确支持范围。
4. MCP 配置：名称、URL、启停、超时、可选凭据；有连接测试、发现到的工具与错误。配置刷新后保留；凭据不可回显、入日志、入任务 prompt。Desktop 沿 OS vault；云端凭据用现有受控密钥机制，不把主凭据传入模型或任意 Runner 环境。
5. 本机和云端任务实际可调用已启用的 MCP 工具。工具名命名空间避免冲突，限制 schema/结果体积；远端工具声明只是提示，不能依赖 readOnlyHint 跳过本系统审批。外部调用显示服务器、工具和具体输入，未经批准不调用；拒绝/取消阻断下一步，不自动重试可能有副作用的 tools/call。禁用/移除后失效，配置更新不得让旧审批悄悄执行新目标。
6. HTTP 出站遵守 SSRF/网络策略：禁止元数据地址、危险 scheme、URL userinfo、任意重定向和 DNS 绕过。云端不能任意访问控制面/数据库内网；管理员显式 allowlist 的测试地址是隔离测试配置，不降低默认策略。桌面可以显式连接本机 MCP，但不把 loopback 能力开放给浏览器云租户。
7. 不伪装沙箱：远端 HTTP 工具在 MCP server 执行，本地 OS 沙箱无法约束远端服务权限。界面与 debug 说明真正执行位置和审批，不声称已被 Seatbelt/Bubblewrap 隔离。

## 实施顺序

A. contracts 定义目录/插件/MCP 公共 DTO；补内置内容、目录与安装流程、本机和云端持久化/权限测试。
B. 官方 SDK Streamable HTTP 客户端 + mock MCP server；先写鉴权、密钥、审批/拒绝、取消、超时、跨用户和禁用行为失败测试，再接实际执行循环。
C. Web/桌面/云端扩展页统一清晰的目录、已安装、MCP 分区；表单校验、忙碌/空态/错误/连接成功反馈，名称和范围清楚；不保留假按钮。
D. 运行完整检查及隔离双控制面/Runner 的真实 MCP HTTP mock 验收。GUI 操作安装启用、连接测试、模型调用审批与结果；保存截图和结构证据。

## 验收条件

- 目录内容引用完整，无重复 ID；老专家/技能仍可选。内置包能安装、启用、进入真实任务上下文，禁用/卸载恢复。
- Web 云账号 A 的配置、密钥、安装内容不能被 B 查看或使用；共享任务不隐式借用别人私有连接。
- 标准 MCP mock server 实际完成握手、发现、调用；模型调用能得到真实结果。协议错误、断线、超时、取消均为清晰终态，连接释放。
- 审批前外部调用计数为 0，批准后恰好一次；拒绝/取消之后为 0；网络/权限失败不降级、不重复副作用。
- 秘密不出现在 GET、debug、导出、日志、schema/prompt。危险地址/重定向被拒绝。
- 有真实桌面和云端操作证据；相关测试、全量测试、架构、类型、Web/desktop build 通过。

## 参考与执行记录

官方 SDK 客户端文档：https://ts.sdk.modelcontextprotocol.io/client
官方连接文档：https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md
参考版本按实际安装的稳定 SDK 锁定，不混用 v1/v2 import。记录 SDK 版本和支持的传输，不宣称全协议功能。

状态：核心实现、独立协议检查、云端真实 Runner 链路及 Electron 实际交互已完成。下文保留首次失败与修复过程；最终结果见末尾验收记录。

### 独立验收准备

基线沿用上一轮已通过的 130 文件 / 789 项测试和类型、架构、桌面构建；本轮新增修改后再次跑相关测试和完整回归。

已准备独立 JSON-RPC HTTP fixture（`data/ecosystem-review/mock-mcp.mjs`，仅临时验收，不打真实第三方）：支持 initialize、session header、tools/list、tools/call、取消通知和 DELETE 关闭；提供 echo、刻意谎报 readOnlyHint 的 write_marker 计数工具、慢调用，以及重定向到元数据地址的拒绝探针。它独立于业务 MCP 实现，用于确认真实线协议和审批前外部副作用计数。

重点复查：cloud-runner 当前只在 requireApproval 非 false 时传 authorizeTool；MCP 不得因普通工具自动档绕过专属审批。现有 SSRF helpers 对部分 IPv6 表示的覆盖需逐项测试，不能仅检查字符串后直接用默认 fetch 再解析一次 DNS。

### 协议层独立检查

- 已保存改造前云端专家页、设置页 1280×800 截图到 `docs/evidence/ecosystem-mcp-2026-09-23/`。
- `data/ecosystem-review/check-streaming.mjs` 用不主动结束 HTTP 响应的合法 SSE 服务测试标准 Streamable HTTP。官方 SDK 默认 fetch 已完成 initialize、tools/list、tools/call 和 DELETE（204），33ms，3 条流、1 次会话终止；结果见 `data/ecosystem-review/stream-baseline.json`。此测量只验证本机协议功能，不能代表产品性能。
- 初始产品连接器缓冲到响应 end，不能正确处理上述流；审查还发现 204 body、超时未生效、工具 schema 丢失、名字截断和会话清理缺口。已交给 Cursor 修复，产品链路尚未通过，不能以 SDK 基线替代验收。

产品连接器第一次独立复验已通过同一个保持打开的 SSE fixture：3 条流、1 次 DELETE，76ms（`stream-product.json`）。后续又复现两项未通过：`check-timeout.mjs` 配置初始化超时 500ms，但 2000ms 未结束；`check-secret-redaction.mjs` 显示远端回显的合成凭据进入工具描述与调用结果。已提交 Cursor 修复，完整验收仍未完成。

### 并行实施与待修审查（15:18 左右）

验收方已接手内置插件：contracts/plugins.ts、server 插件目录路由与原子安装、cloud/ecosystem-plugins.ts（按 owner PostgreSQL 保存）、capabilities 接入、ExtensionsPanel 与云设置入口。相关 4 文件 10 项测试已通过；Web/Cloud 类型检查通过；已在隔离本机 :52740 实际安装并启用编码质量包、查看技能内容。MCP 仍由 Cursor 负责。

Mac 锁屏导致当前无法继续操控 Cursor 或 GUI，已请求手动解锁。以下审查意见尚未成功送达 Cursor，后续必须修复验证：

- cloud/mcp-servers.ts /internal/mcp/invoke 使用 JSON.stringify 比较 PostgreSQL jsonb 审批参数与请求参数。jsonb 键顺序会变化，应改结构等价/SQL jsonb equality，先加两个属性顺序变化的回归。
- /internal/mcp/tools 与 invoke 当前仅以 run.owner_id 挂载全部私人连接。协同项目不能隐式借用发起者私人连接，默认应不挂载，并在调用端再次拒绝。补停用账号、租约失效拒绝发现/调用。
- 审批需要显示目标服务器与执行位置，并绑定目标版本，不能只呈现模型工具别名。

初始化500ms超时复验现为503ms拒绝；合成凭据在描述和结果的回显脱敏复验已通过。仍需实际云调用、取消与配置变更验证。


## 最终集成与真实验收（2026-09-23）

### 已完成

- 内置 5 个插件包 / 5 位专家 / 5 项技能，安装默认停用，查看内容后启用；本机已有 JSON 导入能力保留。云端按账号保存到 PostgreSQL，命名空间避免与自建内容冲突，任务使用当时解析出的能力上下文。
- 白蓝扩展目录、搜索、内容预览、安装管理和 MCP 连接表单，桌面与 Web 共用组件；错误、空态、即时保存说明与手机布局均实际检查。
- 官方 SDK Streamable HTTP 工具发现、带凭据调用、配置编辑、停用和超时。桌面系统保险箱、云端加密保存，Runner 不接触凭据。
- MCP 独立审批覆盖普通自动档；审批绑定 URL 与配置版本。解决 JSONB 参数顺序、私人连接进入协同任务、账号/租约失效、取消无法传递、保险箱更新竞争、超时失效、SSE 不结束和 204 响应等问题。
- 新增回归复现并修复：同时修改 MCP 地址与超时时，旧地址被写回；schema 参数名回显凭据时直接拒绝挂载，避免泄漏或改变参数语义。

### 可复验的证据

环境：macOS arm64、Node 24、Docker Desktop；两个控制面（8893/8894）、Nginx 8892、两个 Runner、PostgreSQL 17。仅用本地模拟模型和独立 JSON-RPC HTTP 服务；没有请求真实付费模型。普通 8890 平台未重建。

- 全量测试：141 个文件，822 项通过。`data/ecosystem-review/full-tests-final.log`。
- 协议独立探针：合法 SSE 保持连接时仍完成调用与 DELETE；本机和云端连接器均通过；500ms 初始化超时实测约503ms结束；描述、结果中合成凭据回显被清理。这是功能测量，不代表生产容量。
- 云端 `scripts/smoke-ecosystem.mjs`：25 项检查，覆盖鉴权/双账号隔离、并发安装、真实专家上下文、跨控制面配置、真实 Runner 工具调用、自动档仍审批、重复批准409、拒绝/取消无写入、旧配置审批失效、在途取消与超时。报告在 `cloud-acceptance.json`。
- Electron 实际点击：完成首次模型配置、内置包安装启用、带凭据 MCP 保存/发现/启用，发起工具对话，审批前计数未增加；退出并重新启动，待审批与凭据仍有效；批准一次后计数仅+1，收到外部工具真实响应。`electron-proof.json`。二进制保险箱及明文 JSON 检查无合成凭据原文。
- 桌面截图审查发现“外部 MCP 被标注为原生沙箱命令”，已修复为目标URL、明确执行边界和可见参数；保留同尺寸 `electron-approval-before.png` / `electron-approval-after.png`。
- Web 实际操作：目录内容预览、安装启用、刷新保留；本机 MCP 无密钥服务保存/发现；云端普通账号添加私网地址得到可见拒绝。宽屏1280×800与本机移动390×844截图。

### 交付与边界

使用与复验入口：[扩展与 MCP](ecosystem-mcp.md)。截图与脱敏报告：[evidence/ecosystem-mcp-2026-09-23](evidence/ecosystem-mcp-2026-09-23/)。未提交或推送 Git。

本期只提供 Pig 运行时的 HTTP MCP 工具客户端；stdio、OAuth、资源/提示词、分页订阅、自动插件升级、云端第三方脚本市场均未实现。共享项目的私人 MCP 默认不可用。外部执行不是本机沙箱，不能回滚；单审批不自动重放，不承诺 exactly-once。构建仍有已有的 Web 主包超过500kB提示，无编译错误。
