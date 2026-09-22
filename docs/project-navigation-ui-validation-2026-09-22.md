# 项目导航、账号与工作区 UI 验证

实现与边界：

- 桌面保留同一个 App 导航，项目项下包含普通项目、项目协同；协同组件内嵌，不再由 main 切换为另一套整页工作台。旧共享链接兼容，新链接使用 projects/collaboration 分支。
- 普通本机项目可保存绝对工作区目录、查看生效目录；新任务继承该目录，文件树与预览携带 sessionId。改目录不会迁移已有任务或文件。
- Web 中普通项目与项目协同分组，工作区展示实际会话文件版本与下载；不声称不同会话共享实时可写文件系统。
- 账号密码申请、待审批说明和登录是默认流程；旧令牌入口收在高级连接。桌面使用相同表单与安全凭证桥接。
- 本机任务保留真实 Docker 沙箱开关。远端始终容器隔离，联网策略只支持逐次授权 HTTPS GET 或禁止联网。

2026-09-22 验证：

1. Chrome / 8892 隔离控制面与真实 Runner、mock 模型：浏览器申请账号、待审登录被拒绝、管理员批准后密码登录；新建普通项目和命名工作区，真实写读任务产生一个可下载文件版本；两个密码账号在项目协同中共享作者、审批和回复。
2. Chrome / 8799 独立本机数据目录：工作区保存刷新保持，新项目 session 固定正确目录；文件树显示 PROJECT_ONLY.txt、没有全局 GLOBAL_ONLY.txt；预览匹配项目文件内容。项目协同保留外层导航，返回普通项目仍在同一工作台。
3. 真实 Electron 独立 userData：原生 window.pigDesktop 存在，账号密码通过桌面安全凭证桥接登录，项目协同内嵌且普通项目切换正确。没有用浏览器伪造桌面对象。测试 Electron 已退出，没有关闭用户现有实例。

证据：`data/project-ui-evidence/report.json`、`local-report.json`、`electron-report.json`。浏览器截图为 1440×900 和 390×844，原生 Electron 图片保留设备 2× 缩放。已目视检查最终布局，手机无横向溢出。

修复回归中发现的缺陷：项目详情异步初始化会清空刚输入的工作区；旧项目加载 effect 可能在导航后回写旧选择。现在使用项目草稿身份与 effect 清理，加载完成才显示对应编辑内容，同项目刷新不重置草稿。项目分支位置、空态误报只读、双“新任务”操作含义和无会话时无效分享也已修复后重拍。

复现脚本：`scripts/smoke-project-workspace-ui.mjs`、`scripts/smoke-local-project-workspace-ui.mjs`、`scripts/smoke-project-electron-ui.mjs`。使用隔离 mock 集群；本机脚本需要 8799 隔离 harness 和 data/project-ui-local-* 夹具。账号文件在 ignored data 目录，仅为验收临时账号，不进入文档或提交。
