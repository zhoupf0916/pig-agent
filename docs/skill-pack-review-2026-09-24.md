# 独立审查修复清单

本页记录本轮 Codex 独立审查给 Cursor 的修复事项。以下事项已落实；最终支持范围与实测证据见 [技能包升级记录](skill-pack-upgrade-2026-09-24.md)。前端与最终集成验收由 Codex 完成，后端与 contracts 由 Cursor 实现并修复。

- 新增 `apps/server/src/agent/skill-materialization-boundaries.test.ts` 两个实际失败的行为测试：SKILL.md 和技能目录指向工作区其他位置的符号链接会绕过审批覆盖原文件。物化须拒绝全部符号链接，不覆盖用户文件。
- 同一 workspace 多个会话、多个技能版本不能互相覆盖脚本。应使用内容摘要隔离的路径，路径与提示词一致；相同内容重复物化可复用，但发现内容被修改须拒绝覆盖。
- 云端私有及插件技能实体 ID 含下划线，不能直接当作标准技能 name（当前会被 validateSkillName 拒绝）。保留合法的技能 name，实体 ID 仅用于归属。
- `load_skill` 工具和自动建议也须物化资源并返回路径；不能只有显式 skillIds 有文件可读。
- 桌面远端自动化需 `GET /api/remote/v1/skills`；增加 remote.ts 的窄白名单和行为测试。
- runtime contracts export 使用 `.js`，否则 Web 类型检查 TS5097。
- 本机和云端导入应严格校验完整 files 数组，不能滤掉非法条目后报告成功，拒绝重复 SKILL.md，SKILL.md 计入体积。
- 技能正文、displayName 和资源路径在两端都需可展示。保留源许可证。

交接时要求先运行失败测试及相关测试、架构检查、各应用类型检查与构建；Cursor 不修改前端、不提交推送，由 Codex 最终集成提交。

## 集成补充

- 本机 `PATCH /api/sessions/:id` 也必须接受 skillIds 并保存快照；目前仅 create 接通，输入框 slash 使用 PATCH。运行中禁止修改；明确清空数组应清除显式技能。专家绑定的技能也必须成为快照，不应每次从可变库重新取。
- 控制面调度但本机执行的自动化：`apps/server/src/automations/control-schedules.ts` 当前 Delivery 只有 prompt，cloud `/v1/schedule-deliveries` 必须传 server-resolved skillSnapshots，领取成功后执行时落入 session，不能丢技能。
- cloud-runner.ts 目前先物化技能再 extractWorkspaceSnapshot，工作区归档可覆盖刚物化的技能；应先恢复工作区，后校验物化。staging 错误要进入任务失败终态，不得卡 running。
- 当前按 session.skillSnapshots 注入后仍自动加载最新的同名建议/专家技能，会破坏“旧任务快照不被修改”的语义；按ID去重并优先快照。
- 一句话/手动创建的本机技能也需要可选 `displayName` 中文名：`skillDraftSchema`、`saveUserSkill` 保存 frontmatter metadata.display-name，草稿生成引导生成中文说明。否则新建后仍只显示英文ID。前端将发送 displayName。
- 云端对话 UI 需要恢复当前账号已选技能，不能刷新后显示空。请 `conversationSnapshot` 按调用者过滤，仅在 run.author.id === caller.id 时返回该轮 skillIds 和简单 displayName 列表（不要泄漏其他成员私人技能正文）。GET 与 SSE 两处一致传 caller id。前端将消费 run.skillIds，并在未编辑选择时沿用快照。
