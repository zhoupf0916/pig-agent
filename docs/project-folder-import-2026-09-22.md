# Web 项目目录导入

Web 的执行资源仍由控制面调度 Runner 容器。浏览器选择文件夹时上传的是当前文件的云端副本，不会持有本地绝对路径，也不会持续同步或回写用户磁盘。客户端原有本地工作区绑定保留。

## 接口与边界

- `POST /v1/projects` 可同时提交 `workspaceFiles: [{path, content}]`，与项目创建在同一数据库事务保存；`path` 去掉选择目录的顶层名称。
- `PUT /v1/projects/:id/workspace/files` 提交 `{files: [{path,content}]}`，原子替换个人项目的初始文件，空数组清空。仅项目所有者可写，协同项目不支持该入口。
- `GET /v1/projects/:id/workspace` 返回 `seed: {fileCount,byteSize,files}`，只含清单，不返回正文。
- 支持最多 400 个 UTF-8 文本文件，每个不超过 200,000 bytes，合计不超过 2 MiB。拒绝路径穿越、绝对路径、文件/目录冲突、重复路径、NUL 二进制，以及 `.env*`、常见密钥/凭据、`.git`、依赖与构建目录。文件名过滤不能识别任意源码中的所有秘密，上传界面应告知用户检查目录内容。
- 种子存储在 PostgreSQL `project_workspace_files`，不放在 `shared_projects` 的整行响应里；运行元数据没有 `input` 或源文件正文。
- 新任务创建时复制种子到不可变的运行输入。项目种子更新不会改变已排队任务。任务重放只比较原始 `requestInput`，不要求重新上传文件，也不受种子更新影响。
- Runner 在独立 `/workspace` 创建子目录并写入文件。后续对话优先恢复上一轮快照，不重新覆盖项目种子；新对话读取最新种子。

## 可复现验证

```sh
pnpm exec vitest run apps/cloud/src/project-files.test.ts
pnpm --filter @pig-agent/cloud typecheck
pnpm --filter @pig-agent/server typecheck
node scripts/build-cloud.mjs
node scripts/cluster-local.mjs up
node scripts/smoke-project-folder-import.mjs
```

脚本固定使用测试集群 `127.0.0.1:8892` 和 `data/cluster-local/stack.env`。使用模拟模型，但运行、容器、文件读写、PostgreSQL 与快照均为真实执行。会新增独立验收项目和三个任务，不修改真实 `8890` 服务。报告不包含令牌或文件正文。

实际结果（2026-09-22）：18 项单元测试、控制面和 Server 类型检查通过；两个控制面与两个 Runner 的测试集群完成三个真实容器任务，全部成功。证据见 [API 验收报告](evidence/project-folder-import-2026-09-22/api-report.json)。验证包含上传权限与过滤、运行输入固定、相同幂等键重放、会话快照优先和新会话采用新种子。
