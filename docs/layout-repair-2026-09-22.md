# 工作台布局回归 · 2026-09-22

环境：隔离 `http://127.0.0.1:8892`，双控制面与双 Runner，本地 Chrome，既有独立测试账号及既有真实容器执行记录；没有修改真实 8890 服务、用户数据或模型配置。

原缺陷：完整工作台壳套入云工作区后，同时显示全局导航与常驻项目栏、双层顶栏；1280 宽成果栏进一步挤压对话。手机项目抽屉关闭按钮被通用隐藏规则吞掉。未选协同项目时仍给出无法发送的输入区。

修复后的结构：全局导航保留全部入口；任务仅有一个上下文顶栏，项目和最近会话按需打开抽屉；成果面板覆盖显示，关闭后回到原宽度对话。空协同项目给出创建或加入入口，隐藏无效输入区；新任务输入区紧随引导内容。最终截图复查另发现桌面手机导航按钮被通用按钮样式错误显示，已增加精确隐藏规则并重新验收。

实际操作与截图：

| 场景 | 尺寸 | 改前 | 改后 |
| --- | --- | --- | --- |
| 工作台空态 | 1440×900 | [改前](evidence/layout-repair-2026-09-22/before-conversations-desktop.png) | [改后](evidence/layout-repair-2026-09-22/after-conversations-desktop.png) |
| 普通项目 | 1440×900 | [改前](evidence/layout-repair-2026-09-22/before-projects-personal-desktop.png) | [改后](evidence/layout-repair-2026-09-22/after-projects-personal-desktop.png) |
| 项目协同 | 1440×900 | [改前](evidence/layout-repair-2026-09-22/before-projects-collaboration-desktop.png) | [改后](evidence/layout-repair-2026-09-22/after-projects-collaboration-desktop.png) |
| 协同空态 | 390×844 | [改前](evidence/layout-repair-2026-09-22/before-collaboration-mobile.png) | [改后](evidence/layout-repair-2026-09-22/after-collaboration-mobile.png) |
| 项目抽屉 | 390×844 | [改前](evidence/layout-repair-2026-09-22/before-project-drawer-mobile.png) | [改后](evidence/layout-repair-2026-09-22/after-project-drawer-mobile.png) |
| 专家技能选项 | 1280×800 | [改前](evidence/layout-repair-2026-09-22/before-options-desktop.png) | [改后](evidence/layout-repair-2026-09-22/after-options-desktop.png) |
| 成果与过程 | 1280×800 | [改前](evidence/layout-repair-2026-09-22/before-artifacts-desktop.png) | [改后](evidence/layout-repair-2026-09-22/after-artifacts-desktop.png) |

以上截图逐张查看，确认布局结构、控件可见性与信息宽度。自动化操作同时断言：无横向溢出；单任务顶栏；桌面不出现手机菜单；手机关闭按钮与 Escape 均可关闭项目抽屉；手机全局导航能进入专家页；成果展开不改变聊天主区宽度，Escape 关闭；无浏览器 pageerror。结果见 [report.json](evidence/layout-repair-2026-09-22/report.json)。

复现：隔离环境已有 `data/project-ui-evidence/accounts.json` 测试账号夹具时运行 `node scripts/smoke-layout-repair.mjs`。脚本只登录与读取既有记录，不创建任务、不变更模型；若重新初始化空数据库，应先建立独立账号及一个包含成果的任务。截图存入 `data/layout-repair-evidence/`。

此记录验收的是布局，不代表审批语义与本地多工作区已验证；后两项由对应专项证据记录。
