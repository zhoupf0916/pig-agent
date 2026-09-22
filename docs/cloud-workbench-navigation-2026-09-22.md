# Web 完整工作台与项目分支

## 产品目标与边界

Web 与桌面使用一致的全局导航：工作台、项目（普通项目 / 项目协同）、专家与技能、自动化、记忆、搜索、远端记录及设置。Web 不再以一个精简会话页面替代整个产品；项目协同是项目分支。桌面仍使用既有 App 与本机功能，Web 仅调用控制面 `/v1` 与账号 `/auth/web`，所有执行由远端 Runner 容器承担。

## 实现

- `CloudAppShell` 复用原 `app-layout`、`global-sidebar`、`global-links`、`project-branches` 和 `task-header` 样式；会话 `CloudWorkspace` 作为任务内容区嵌入。手机保留同一导航及键盘焦点约束。
- 专家和技能可手动创建、编辑、查看内容；一句话创建先生成草稿再确认保存。真实模型未配置时显示服务错误，不假装生成成功。内置资源只读。资源按 ID 传入任务；协同分支不暗中继承个人任务的预选资源。
- 账号设置真实保存默认网络、审批、记忆偏好。新任务使用控制面默认值，只有用户显式调整网络策略时提交覆盖值。容器隔离为固定执行条件。
- 记忆增删、搜索、执行记录和自动化均连接实际控制面。私人记忆不会注入协同任务。浏览器只持有 HttpOnly 登录会话，不保存管理员令牌。
- 账号切换增加请求身份版本：旧账号迟到成功/失败响应不能改变新账号状态；401 仅使发出请求时的当前账号失效。

## 验收证据

环境：本地 Docker 多控制面与 Runner 验收栈 `127.0.0.1:8892`，Chrome，桌面 1440×900、手机 390×844。使用独立验收账号。模型为模拟模型，实际审批、控制面调度、Runner 容器写入和读取均真实运行；这些验证不代表真实模型质量或生产容量。

- `scripts/smoke-cloud-shell-ui.mjs` / `data/cloud-shell-evidence/report.json`：完整导航；手动技能创建 → 任务预选；普通 / 协同项目分支；记忆保存刷新；设置保存刷新；自动化、搜索、执行记录入口；手机无横向溢出；A 请求被扣留 → A 退出 → B 登录 → 释放 A 的旧 401 后 B 仍登录。无页面脚本错误；除部署识别外无本机 `/api` 请求。
- `scripts/smoke-cloud-shell-execution.mjs` / `data/cloud-shell-evidence/execution-report.json`：手动专家创建 → 用于新任务 → 请求携带专家 ID 和 `useUserDefaults` → 浏览器批准写入 → 真实容器完成 → 搜索该消息并打开会话。
- `scripts/smoke-cloud-shell-automation.mjs` / `data/cloud-shell-evidence/automation-report.json`：新建仅手动自动化 → 立即执行 → 无会话执行详情 → 允许本次写入 → 容器完成 → 预览 `PIG_CLOUD_CONTAINER_OK` → 暂停计划 → 历史打开 → 刷新执行深链接。截图 `automation-approval-desktop.png`、`automation-artifact-desktop.png`、`automation-artifact-mobile.png` 已打开检查。
- `apps/web/src/cloud/cloud-api.test.ts`：旧身份 401 不登出新身份、当前身份 401 有效、自动化幂等头保留。
- 截图：同目录 `workstation-desktop.png`、`skills-desktop.png`、`projects-desktop.png`、`memory-desktop.png`、`settings-desktop.png`、`settings-mobile.png`、`navigation-mobile.png`、`approval-desktop.png`、`approval-mobile.png`、`result-desktop.png`、`result-mobile.png`。

## 视觉自审

已实际打开上述截图检查。白蓝色导航和页面结构与原工作台一致；桌面任务仍拥有项目 / 最近会话子栏，执行内容与成果抽屉保持独立；手机用导航抽屉和项目选择控制，不压缩桌面栏位。去掉了工作台子栏重复“新任务”按钮，并避免在关闭默认审批后仍显示“写入前审批”的错误说明。

验证命令：`pnpm --filter @pig-agent/web build`、`pnpm --filter @pig-agent/web typecheck` 和 `pnpm exec vitest run apps/web/src/cloud/cloud-api.test.ts` 均通过。父任务另记录仓库全量测试结果。

## 范围与限制

- Web 的模型与 Runner 资源由管理员管理；个人设置页不提供无效的本地沙箱、桌面控制或模型密钥开关。
- 内置与个人资源不提供删除按钮，当前后端未实现删除契约；创建和编辑为完整可用路径。
- 构建仍有既有体积提示；未宣称性能提升。
