# 运行时专项返工与独立验收

用户授权：通过 Cursor 持续实施，由 Codex 独立验收。业务改动由 Cursor 负责，验收工具和证据由 Codex 负责，避免同时编辑业务文件。不得提交或推送、操作生产环境或使用真实模型批量测试。

## 起点

上一轮结论见 `runtime-debugger-acceptance-review-2026-09-23.md`。当前 8890 为用户平台；8892 为隔离双控制面、双 Runner。集群更新由 Cursor 单独操作，验收不并发重建。

独立本机模拟模型脚本：`data/runtime-debugger-review/independent.ts`。使用临时工作区和数据目录、禁用 dotenv、清理模型环境变量；不读取开发者密钥。基线 13 项检查通过 3 项：取消终态及终态无遗留进行中条目。其余 10 项失败，包括四种文本凭据脱敏、运行中可见、实际请求/响应、finish reason、工具输出脱敏、文件工具错误标为 Seatbelt。基线保存在本地忽略目录，包含的凭据仅为合成标记。

## 验收顺序

| 优先级 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| P1 | 凭据位于结构字段、文本和 URL | 记录入口、详情和导出无合成凭据明文 |
| P1 | 开启/关闭完整内容 | 默认无正文；开启后有实际请求与响应，截断明确 |
| P1 | 原生沙箱、文件工具、主机模式、失败 | 每次实际执行事实准确，失败不降级 |
| P1 | 慢模型与慢工具 | 返回前可见进行中记录，同一条目更新为终态 |
| P1 | 审批、拒绝与取消 | 未批准不写入；拒绝/取消不执行后续副作用，无悬挂调用 |
| P1 | 远端运行与权限 | 运行中可看实时调用；跨用户无法读取或改变配置 |
| P1 | 流式回复与重连 | 发送反馈即时、消息无重复、回复连续、滚动可控 |
| P2 | 固定任务集 | 冷/热样本、P50/P95、环境和测量口径可复现 |
| P1 | 回归 | 相关测试、全量测试、类型检查、架构检查、桌面构建通过 |
| P1 | 实际界面 | Electron 本机/远端及窄窗截图与交互证据 |

以上均是待验收要求，不表示已完成。待 Cursor 交付后用同一套探针独立复测；失败项退回修复后再次验证。

## 第一轮增量复测

- 本机初始 13 项探针已全部通过；新增用量数字、实际请求的 `tool_call_id` 与 `temperature` 后达到 16/16。
- 独立全量测试：126 文件、762 项通过。架构检查、根类型检查以及 cloud/worker 类型检查通过。
- 独立桌面构建通过；实际 Electron 中确认模型未返回时可见“进行中”，完成后可查看请求体、回复、finish reason 和 TTFT。中间截图：`evidence/runtime-debugger-rework-2026-09-23/intermediate-details.png`。
- 实际界面详情仍是一大块 JSON，已退回 Cursor 要求分区折叠与单独复制，尚未通过最终交互验收。
- 新增审批拒绝探针后为 17/19：写入被正确阻止，但调用遗留 running，缺少终态。已交回修复。此处数字的增加来自增加验收场景，不是原有检查退化。
- 远端独立脚本已备好：`data/runtime-debugger-review/remote.mjs`，只针对隔离 8892，凭据不打印；待隔离集群更新后执行。

当前结论仍为进行中，不得把以上阶段性通过写成整体验收完成。

## 第二轮独立验证

- 本机 19/19 通过，另行验证 `.env API_KEY`、JSON password、Basic Authorization 三种合成文本均被脱敏。
- 真实远端最初暴露 HOME 与 workspace 重合造成沙箱拒绝；批准 run 虽标成功，实际工具报错。已修后重跑远端 16/16 通过，包含真实 `cloud-proof.txt` 产物、Bubblewrap 后端、运行中记录、正文选择、跨成员 404、拒绝/取消无产物与无 running 残留。
- Electron 正常启动曾被 smoke.cjs 模板字符串语法错误阻断，修复后重新实际打开。桌面已经操作读取、停止、连续两项审批（第一项批准、第二项拒绝）与 HTTP 503。磁盘验证：未批准时两文件均不存在，批准后仅第一文件存在，取消目标文件不存在。
- 分区后的概览/响应、取消与错误截图在 `evidence/runtime-debugger-rework-2026-09-23/`。审批截图尚未列为最终证据：测试模拟器曾复用 tool_call id，已改为逐请求唯一 ID，最终复验将使用新测试会话。

## 收尾还需核对

1. Electron 远端完整正文开关与首次/后续运行参数传递，默认关闭且隔离会话。
2. 并行只读的并发上限、失败/取消与真实计时；上下文压缩的总预算及合法消息配对。
3. 八类基准按 `runtime-debugger-benchmark-review-2026-09-23.md` 修正；不接受假热启动或无行为断言的样本。
4. 调试记录除了每会话 200 条，还需明确总保留上限和单条总体字节上限。当前 Map 会话数、对象字段总量仍无界；不能只限字符串长度。
5. `finishDebugSpan` 结束本地审批时仍沿用初次 staging 的 duration，未计入真正等待；`closeOperationSpan` 未同步批准后的 op.output。验收要确认完成详情显示实际结果和正确的等待/执行时间范围，不能把 staging 耗时当审批总耗时。
6. 最终完整回归及 Electron 本地/远端、窄窗操作证据。

本地审批细节的独立复现脚本：`data/runtime-debugger-review/local-approval.ts`。临时目录、禁用 dotenv，真实 stage → approve/reject API → 检查磁盘与调试输出。初测 6/9，通过状态码、终态、批准文件内容及拒绝无文件；失败项为批准/拒绝等待耗时和批准后的实际输出未更新。

## 第三轮独立验证（仍在收尾）

- 本地审批修复后 9/9 通过，包括真正等待时间和执行后的文件内容；本机综合探针 19/19。
- 修复显式继续小队任务被停止检查点误拦截的问题；保留原断言，另加取消不重放后续写入。独立全量回归 130 文件、786 项通过（13:35）；根、cloud、worker 类型检查和架构检查通过。
- 八类模拟任务共 80 个样本通过真实行为断言。冷热总耗时不包括冷启动，冷启动单独记录；无 token 的任务 TTFT 为 null。重连项目验证的是持久事件游标续传，不等同于实际断网故障测试。没有可比的改造前延迟基线，不宣称加速比例或生产容量。
- Electron 首次远端运行已实际成功：开启本会话正文记录后展示远端模型请求、响应、HTTP 200、TTFT 和工具条目，生成真实产物。初始 401 来自测试 profile 没有写入 OS vault，补齐隔离测试凭据后通过，不是产品鉴权缺陷。
- 新发现需修复：开发者页挤在远端成果的 350px 侧栏，列表空间不足，已交回 Cursor 修复真实父布局。中间证据 `evidence/runtime-debugger-rework-2026-09-23/desktop-remote-response.png`。
- 新发现需修复：Electron 远端审批字段未设置时，UI 展示已勾选，首次 payload 却省略 requireApproval，实际继承控制面 false，导致无审批写入。隔离运行 `run_f5f3c008e1d84850ab50d8cad69ddb69`、本地任务 `ses_28ece69e311690b4`。已要求先补失败行为测试并使显示、传递与实际策略一致，之后再实际验证审批。

### 正文调试开销补测

同进程预热 4 次，交替关闭/开启正文，各 20 次本机 HTTP mock 请求，模拟等待约 20ms。请求含约 3900 字符用户输入和实际工具定义；回复约 1700 字符。元数据在两组都开启，未覆盖 UI 渲染、跨节点传输或生产负载。

| 模式 | 任务 P50/P95 ms | 扣除实际 mock 等待后 P50/P95 ms | 单次 trace 大小中位数 |
| --- | --- | --- | --- |
| 正文关闭 | 23.54 / 25.96 | 2.91 / 4.60 | 841 B |
| 正文开启 | 24.24 / 25.92 | 3.34 / 4.89 | 13786 B |

原始样本及环境：`evidence/runtime-debugger-rework-2026-09-23/debug-content-overhead.json`。小样本仅说明此负载下未观察到显著阻塞，不能外推全部场景或宣称零开销。

## 最终功能验收与界面收尾

### 已独立通过

- **完整回归：130 个文件、789 项测试通过**；根、cloud、worker 类型检查、架构检查、桌面构建和入口语法检查通过。最后的列表/时间线布局与文案修改后，再次通过 Web 类型、架构和 diff 空白检查，并重启实际 Electron 核对最终构建。
- 本机综合检查 19/19；本机审批 9/9；真实双控制面/双 Runner 隔离环境远端检查 16/16。脱敏汇总见 `evidence/runtime-debugger-rework-2026-09-23/checks-summary.json` 与 `local-approval-checks.json`。
- Electron 连续审批已实际操作：`approval-one.txt` 和 `approval-two.txt` 起初都不存在；批准第一项后仅第一项存在；拒绝第二项后第二项仍不存在。截图为 `desktop-approval-pending.png` 与 `desktop-approval-rejected.png`。
- Electron 默认远端审批缺陷已修复并真实复验：新建任务只选择远端，没有手动切换审批 checkbox；持久会话及实际控制面都为 `requireApproval=true`。运行 `run_f1b05b0a974a4bbead5064e59112dad5` 等待期间只有一个 pending 审批，没有 write_file 完成事件；点击批准后成功生成 `cloud-proof.txt`，有效沙箱为 Bubblewrap，没有 running 残留。结构证据为 `ui-remote-pending.json` 和 `ui-remote-completed.json`。
- 正文调试默认关闭，本会话显式开启后远端才采集。首次/后续运行传递与其他会话不继承已有测试。实际 Electron 的远端页面显示了真实 Runner 的请求、响应、HTTP 状态、TTFT、审批和工具记录。
- 最终开发者面板支持加宽/展开；调用列表独立滚动，时间线默认折叠；详情与错误有独立可用滚动区域；开发者页隐藏导入条，文件页保留。已重新启动最终构建，并实际点选写入调用、看到真实执行结果。最终截图 `desktop-remote-debug-final.png`，与中间失败布局 `desktop-remote-response.png` 都为 **1288×768**。
- Cursor 生成的本机/远端窄窗截图已独立查看：`../runtime-debugger-finish-2026-09-23/developer-narrow.png` 与 `developer-remote-narrow.png`（960 CSS 像素宽、2× 输出，1920×1654 PNG）。本机有调用记录；远端图是尚未运行的空态，不能当作窄窗真实 Runner 完整交互证据。

### 保留的边界

1. 本机 trace 在服务进程内存中，重启丢失；远端沿运行事件保存快照。正文仅在显式开启后采集，未采集字段不会补造。敏感文本脱敏是纵深措施，不能证明任意业务文本里所有秘密都能识别。
2. 工具调用总耗时可能包含审批等待，应结合独立 approval 条目判断；没有用跨主机未同步时钟计算端到端耗时。
3. 基准为本机 mock：80 个固定场景样本及 40 个正文开关样本。没有真实供应商速度比较、生产容量或全链路网络故障结论；游标恢复测试不等同于真实断网测试。
4. 桌面构建仍有前端单 bundle 大于 500KB 的提示。未删除测试、未降低断言、未推送 GitHub，8890 用户环境未重建。

### 中断点与恢复

最终手动窄窗操作期间 Mac 锁屏，CUA 明确返回无法自动解锁，已请用户手动解锁。此时没有未结束的远端验收任务。**最后的窄窗真实远端点击验收仍待完成，不将它标为通过。**

恢复时：

1. 解锁 Mac，选择运行中的隔离 Electron（PID 90149；如果已退出，运行 `node data/runtime-debugger-review/launch-scenarios.mjs`，Node 24/Pnpm 路径见下方）。隔离 profile 为 `data/runtime-debugger-review/scenarios-final`，已有加密 fixture 凭据，勿复制到用户配置。
2. 打开任务 `ses_0b7dfdf7a348707c` → 文件与产物 → 开发者。真实远端运行已成功且快照保留，无需再次调用模型。
3. 在最小支持窗口宽度 960px 下操作调用列表、请求/响应、执行环境、筛选和关闭面板。截图保存 `desktop-remote-debug-narrow-final.png`；确认无横向溢出、主要按钮可达、点击条目后内容更新。该步骤完成后追加验收结论，再停止本轮隔离 mock/Electron（勿停 8890/8892）。

可复现基础验证：

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
pnpm check:architecture
pnpm typecheck
pnpm test
pnpm --filter @pig-agent/cloud typecheck
pnpm --filter @pig-agent/worker typecheck
pnpm desktop:build
node scripts/mock-task-bench.mjs
```

基准只连接自身 mock；不要为了复现改用真实 Key。重建 desktop-dist 会替换运行资源目录，开发中重新构建后须退出并重启该隔离 Electron，不能仅刷新仍持有旧目录的进程。
