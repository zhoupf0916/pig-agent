# 本地项目多工作区

每个本地项目可以关联最多 32 个现有目录，例如应用源码、文档库和服务端仓库。工作区仅保存目录关联，不复制、创建或删除用户目录。云端项目仍由控制面分配容器目录，不允许通过这些本机 API 操作客户端文件。

项目数据增加 `workspaces: [{id,name,path,createdAt}]` 和 `defaultWorkspaceId`。保留 `workspaceRoot` 为默认目录兼容字段。旧项目只保存 `workspaceRoot` 时，读取阶段归一化为稳定的 `ws_legacy`，不在读取时重写用户文件。旧版修改 `workspaceRoot` 会更新默认工作区；清空该字段移除默认关联并选择剩余首个目录。

## API

以下本机接口沿用服务端本地访问安全边界，不开放到纯云 Web：

- `POST /api/projects/:id/workspaces {path,name?,setDefault?}`：关联目录，返回完整项目（201）。
- `PATCH /api/projects/:id/workspaces/:workspaceId {path?,name?,setDefault?}`：修改目录、名称或设为默认，返回完整项目。
- `DELETE /api/projects/:id/workspaces/:workspaceId`：移除关联，返回完整项目。默认项被移除后选择剩余首项；无关联时新任务使用全局目录。
- `POST /api/sessions {projectId,workspaceId?,expertId?,expertTeamId?}` 或 `POST /api/projects/:id/sessions {workspaceId?}`：选择指定工作区，省略时选择项目默认。

目录必须是可读取、可遍历的现有绝对目录，解析符号链接后保存规范路径。同项目不能重复关联相同规范路径。不存在目录、相对路径、跨项目工作区均拒绝；无项目时不能指定工作区。关联不授予超出当前进程系统权限的读写能力，执行仍受既有沙箱与审批限制。

任务创建时固定 `workspaceId`、`workspaceName`、`workspaceRoot`，后续重命名、改目录、改默认或移除关联均不改变该任务的执行目录。新增任务时再次验证目录。已有缺少目录快照的历史任务继续原有行为，不做推测性迁移。

## 验证

```sh
pnpm exec vitest run apps/server/src/store/project-workspaces.test.ts apps/server/src/store/project-workspace.test.ts
pnpm --filter @pig-agent/server typecheck
```

2026-09-22：4 项真实 Hono 路由和临时文件系统集成测试通过，Server 类型检查通过。覆盖并发添加不丢项、默认选择、指定目录、重复/非法目录拒绝、跨项目拒绝、移除不删除目录、任务快照保持、旧项目稳定迁移以及原产物读取路径回归。此证据针对后端行为，客户端截图与交互验收另行记录。
