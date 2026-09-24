# 技能包升级 · 2026-09-24

对齐 [Agent Skills 规范](https://agentskills.io/specification)。本轮按功能提交并推送代码；未启动 Docker，未部署线上服务器。

## 基线

- 内置技能是 `skills/*.md` 纯正文，frontmatter 只支持单行 `key: value`。
- 专家已有 `skillIds` 数组，云端任务把专家与技能正文拼进 `capabilityContext`。
- 插件技能只有 `body`。脚本不会写进工作区。
- 本机与云端自动化不保存、不传递 `skillIds`。
- 精选目录提交 `e4cea85` 可改为文件包；许可证文件保持不动。

## 验收

- `SKILL.md` 必须有 YAML frontmatter。`name` 1–64，仅小写字母、数字、连字符，不能首尾或连续连字符，且与目录名一致。`description` 1–1024。支持多行 YAML 与 `metadata.display-name` 中文展示名。
- `scripts/`、`references/`、`assets/` 可选。激活技能只把 `SKILL.md` 正文和相对路径索引进提示词，不把资源正文塞进系统提示词。
- `allowed-tools` 只记录，不自动扩大工具、网络或审批权限。脚本仍经现有 `run_shell` 沙箱审批。
- 包文件经路径校验后物化到任务工作区 `.pig/skills/<id>/<内容摘要>/`，供现有工具读取。拒绝 `../`、绝对路径、重复路径和超限体积。
- 任务保存技能快照，之后改技能库不改变已创建任务。跨账号不能读到他人技能文件。
- 本机与云端自动化可选技能，调度创建任务时写入快照。
- 旧的单文件 `.md` 技能仍能列出和加载。
- 至少一个内置包带可运行的 Python 标准库脚本和 reference。已有内置技能说明为中文。

## 决策

- 共享校验与快照类型放在 `packages/contracts`，不增加运行时依赖。
- 物化放在 server（本机回合与 Runner 入口）。控制面只保存快照 JSON，不写执行机磁盘。
- 客户端不能在创建任务时自带文件内容；快照由服务端按账户解析。
- 目录包的 `name` 必须等于目录名。旧扁平 `.md` 继续用文件名作标识，展示名走 frontmatter。
- 界面复用统一的技能选择组件，接入本机、Web、远端项目与自动化。

## 接口

本机：

- `GET /api/skills`：技能元数据，含 `displayName`。
- `GET /api/skills/:name`：正文、`allowedTools` 和包文件。文件正文不在列表接口返回。
- `POST /api/skill-packs`：`{ files: [{ path: "SKILL.md", content }, ...] }`。校验 frontmatter 与相对路径，保存 `name` 与 `displayName`。写入先落临时目录，再改名；失败只删除临时目录。
- `POST /api/skills`：可带可选 `displayName`。保存进 frontmatter 的 `metadata.display-name`。一句话草稿会要求生成这个中文名。
- `POST /api/sessions`：`skillIds` 必须都存在，响应含 `skillIds` 与 `skillSnapshots`。
- `PATCH /api/sessions/:id`：同样接受 `skillIds`。运行中返回 409。`[]` 清除显式技能。专家绑定的技能一并写入快照。
- `POST /api/experts` 与 `PATCH /api/experts/:id`：未知 `skillIds` 返回 400，不改原绑定。
- `POST /api/automations` 与 `PATCH`：可带 `skillIds`。触发时写入会话快照。

云端：

- `POST /v1/skill-packs`：与本机相同的 `files` 体。`name` 为规范标识，`displayName` 为中文展示名。
- `POST /v1/runs`：服务端写入 `skillSnapshots`，不接受客户端自带文件字节。
- `POST /v1/runs/:id/follow-ups`：`skillIds` 可选。省略则同一成员沿用旧快照；显式数组（含 `[]`）按当前账户校验并替换技能快照。同一成员更换显式技能时保留原来的专家。另一位成员不能沿用上一成员的私人快照。
- `GET /v1/conversations/:id` 与该会话的 SSE：只在 `run.author.id` 等于当前调用者时返回该轮 `skillIds` 和 `{ id, displayName }`。不返回技能正文，也不返回其他成员的技能选择。
- `POST /v1/schedules`：可带 `skillIds`。触发任务时解析并保存快照。

激活提示只含 `SKILL.md` 正文和相对路径。`allowed-tools` 不扩大审批。

## 进度

- [x] 契约校验与解析
- [x] 本机加载、快照、物化、导入原子提交
- [x] 云端快照、跟进技能、自动化传递
- [x] 内置数据分析脚本包
- [x] architecture、contracts/server/cloud 类型检查、全量测试 869 项通过
- [x] 本机技能 displayName、对话快照按调用者返回 skillIds
- [x] 工作区归档排除 `.pig`（不回退）

## 支持范围与使用方式

```text
data-analysis/
  SKILL.md
  scripts/profile_csv.py
  references/metrics.md
  assets/example.csv       # 可选文本资料
```

`SKILL.md` 用 YAML frontmatter 声明 `name`、`description`，可用 `metadata.display-name` 声明中文展示名。当前解析器支持标量、块文本和 metadata 字符串映射，不承诺任意 YAML 语法。资源限 UTF-8 文本、单层目录、ASCII 文件名；脚本当前限 Python。最多 32 个资源文件，单文件 64 KiB，整个上传包（含 SKILL.md）256 KiB。二进制资产、嵌套目录、依赖自动安装不在本轮支持范围。

1. 专家 → 技能 → 导入技能文件夹，预览后确认。
2. 点「查看技能包」检查说明、脚本与参考文件；点「开始对话」建立绑定技能的新任务。
3. 在输入框键入 `/`，按中文名称或用途检索，方向键选择，Enter 加载，Esc 关闭；已选技能可移除。
4. 自定义专家详情可绑定多个技能；内置专家保持只读。
5. 自动化新建与编辑表单选择技能，保存后每次运行生成独立快照。

## 实际验收记录

隔离服务 `127.0.0.1:8799`，离线 OpenAI 兼容模拟模型 `127.0.0.1:8801`，macOS 原生沙箱，未消耗模型额度。模拟模型只决定工具调用；Python 和文件读取是真实执行。

- 浏览器完成技能详情预览 → 开始对话 → `/` 中文搜索 → Enter 加载（不会误发送）。
- 手机 390×844 与桌面截图核对技能库、资源预览、选择菜单、自动化与执行结果。
- 首次真实脚本执行发现 macOS Command Line Tools 只读访问缺失，修复后原生沙箱执行 Python 成功；工作区外写入与网络仍拒绝。
- CSV 样本 3 行，amount 两个数值 12、18 和一个空值；脚本真实输出合计 30、空值 1、退出码 0。
- 审批模式下，读取参考文件后停在脚本单项审批；人工批准前无脚本结果。
- 自动化选择技能并刷新后保留，点击立即运行后新会话含技能快照与实际工具调用。
- 独立审查修复：无效绑定拒绝且保留原状态；符号链接拒绝；技能版本隔离；旧任务快照优先；技能准备失败落终态；私人 `.pig` 资源不自动导出至共享成果。

截图及离线模型记录保存在本机 `data/skill-pack-review/`（按仓库规范不提交 data）。云端账号隔离、调度传递与跟进快照经过行为测试；本轮未启动 Docker 跑云端集群端到端，未将本机证据称为线上验收。

## 最终检查

- 修改的技能相关测试：13 文件 / 40 项通过；迁移临时工作区后的旧测试：4 文件 / 34 项通过。
- `pnpm test`：154 文件 / 869 项通过。临时工作区替代仓库示例目录，保留旧测试断言与有效夹具。
- `pnpm cloud:build`：架构检查、contracts/server/web/cloud/worker 类型检查和构建通过。
- `pnpm desktop:build`：Electron 运行时及界面打包通过。Vite 仍提示单个 JS chunk 超过 500 kB，本轮未做代码分割。
- `git diff --check` 通过。
- 本轮未部署腾讯云，线上版本需另行发布才会显示这些功能。
