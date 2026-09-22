# 原生沙箱与工作台产品化验收

2026-09-22。此文为本轮最新交接记录；更早的产品化记录保留作为历史。当前代码已构建、部署到本地8890，macOS客户端已打包并运行。本轮实现、验收证据与运行说明随仓库提交；本机配置、凭据、用户数据和构建产物不纳入版本控制。

## 产品目标与流程
Web登录 → 个人/协同项目 → 工作区 → 专家/技能（可选）→ 文件与任务 → 单项阻塞审批 → 核对成果 → 续聊。桌面保留本地目录、多工作区、执行位置与原有功能。白蓝工作台，普通项目/协同仍在同一导航体系。

## 已实现和验收证据

| 优先级 / 验收 | 实现与证据 |
|---|---|
| P0 不再用Docker作任务沙箱 | Docker仅部署数据库/控制面/网关/Runner，任务Shell与文件helper走Seatbelt或Bubblewrap+seccomp。双Runner四并发、零任务容器，目录/凭据/网络隔离实测：[运行报告](native-runner-2026-09-22.md) |
| P0 审批阻塞与恢复 | 持久批次checkpoint，第一项待批暂停，批准真实执行后续接，拒绝/取消关闭旧批次，重复决定409，云端审批计时与执行预算分离：[审批报告](blocking-approval-2026-09-22.md) |
| P0 F1/F2/F3 | finish503/提交后丢响应不丢成果；远端预览不读本地同名文件；旧节点重试不能夺回所有权。真实API/Runner/浏览器证据在[evidence/native-2026-09-22](evidence/native-2026-09-22/) |
| P0 文件路径竞态 | 真实Mac旧路径1000请求泄漏2次合成canary；文件工具、预览、快照、撤销、导出、远端交接改helper后36请求0泄漏，安全返回或拒绝，未改外部canary |
| P1 工作台/项目/专家 | 卡片概览、搜索分类、聚焦创建/详情；项目工作区与对话整合；1280项目抽屉；本机原生目录picker。实际Chrome与Electron通过：[UI报告](joydesk-workbench-2026-09-22.md) |
| P1 文件与成果 | Web文件/拖拽/粘贴、状态重试、草稿恢复、输入/成果分区；PDF/DOCX提取、原件鉴权下载和续聊恢复；本机上传至选定工作区：[附件说明](attachments-2026-09-22.md) |
| P1 可读审批 | 写入正文、命令、替换前后直接展示，技术参数折叠；手机批准/拒绝可见可操作；修复旧flex规则挤压正文的实测回归 |
| P1 真实模型 | 实际8890保留provider模式，DeepSeek任务经一次写入审批完成，下载逐字节核对；专家草稿生成成功且未存入用户专家列表：[真实模型](evidence/native-final-2026-09-22/provider.json)、[草稿](evidence/native-final-2026-09-22/provider-draft.json) |

## 视觉与功能验证

- [同尺寸前后对照页](evidence/joydesk-workbench-2026-09-22/comparison/index.html)：9状态×2版本×3尺寸=54截图，1440×900、1280×800、390×844。旧版资源只读取自升级前8890，两套界面使用同一8892测试夹具；不展示用户文件。额外有深色、本机、15条长中文任务和真实Electron截图。
- [消息附件浏览器报告](evidence/message-attachments-2026-09-22/report.json)：上传、刷新恢复、错误阻塞发送、手机、审批完成、历史原件下载，页面错误0。
- 最终架构检查、Web/Server/Contracts/Cloud/Worker类型检查、119文件732测试通过；Web、云端、桌面bundle和macOS arm64 `.app` 打包完成。
- 新helper加入后，两处旧测试假设40ms内已开始网络提交失效；改为等待真实POST/SSE请求再取消，保留“未知提交”和“中断续聊”断言，未降低标准。
- 本地性能样本仅Seatbelt空命令启动20次：median 11.38ms、p95 27.17ms。无Docker对照，无生产吞吐推断；环境见[原始测量](evidence/native-runner-2026-09-22/mac-startup.json)。

## 架构决策

参考[Cursor Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted)的集中控制、Worker执行、池路由/领取及持久成果分工。Cursor托管版公开描述每Agent微VM，本项目不声称与其相同隔离强度，也没有拿到闭源服务源码。

控制面共享PostgreSQL、租约和fencing权威、幂等完成回执和durable outbox保留。原生工具只有明确工作区与系统工具读取权限，凭据环境白名单；Linux命令断网，获批HTTP GET走网关。缺失原生能力/可信helper时拒绝，不静默切换宿主。

## 本地部署与恢复

- 当前Web：http://127.0.0.1:8890/；管理端：http://127.0.0.1:8890/admin/。
- 双控制面/双Runner测试入口：http://127.0.0.1:8892/，控制面直连8893/8894。
- 桌面本轮可执行包：`release/mac-arm64/Pig Agent.app`，已实际启动。旧开发进程已停止；既有4条会话保留，并打开了一条空白新任务供体验。
- 升级前确认无活动任务；数据库备份：`data/cloud-local/backups/2026-09-22T07-01-27.745Z.dump`。保留原stack.env/加密密钥，未改模型渠道或打印密钥。
- 再构建启动：`pnpm cloud:up`、`pnpm desktop:dev`；打包：`pnpm desktop:pack` / `pnpm desktop:dist`。双实例：`pnpm cluster:up`。详见README及[部署说明](local-cloud.md)。
- UI旧版临时8895代理已停止；验收夹具与报告保留，真实用户数据库未用于故障注入。

## 已知边界与下一阶段

本次本地验收已完成，不宣称生产级或exactly-once。

- 共享内核进程沙箱不是微VM；严格跨租户资源隔离/生产容量仍需独立验证。Runner整体cgroup硬限额，任务级资源是500ms采样保护，CPU不是硬份额保证。
- 节点崩溃后未知副作用任务失败并交用户核对，不自动重放。macOS没有Linux PID namespace的完整子孙生命周期保证，Seatbelt权限仍继承。
- Linux需Bubblewrap及user namespaces；Windows原生沙箱未实现，不能降级绕过。
- 图片仅原件，无视觉/OCR；PDF前100页、DOCX正文，复杂版式/批注不保证；本机上传原件由可用工具读取。
- 安装包未签名/公证；跨机器发布仍需开发者签名身份。未连接真实生产环境。
- Web bundle仍有约650KB（gzip192KB）分块提示；没有隐藏该警告。后续可按真实加载数据拆分，不影响当前功能验收。
