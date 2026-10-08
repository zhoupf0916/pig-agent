# 服务器自拉取部署（腾讯云）

在服务器上以 `ubuntu` 执行，服务器自己从 GitHub 拉取公开源码；不需要从构建机上传，也不经过任何第三方文件托管。

| 文件 | 作用 |
| --- | --- |
| `deploy-c666abf.sh` | 备份数据库+配置并校验 → 下载 `main@c666abf` 源码到 `releases/20261008-p0p2-c666abf` → 在 `node:24` 容器内构建 `cloud-dist`（失败时下载 sha256 固定的预构建 release 资产）→ 旧镜像打 `before-*` 标签 → 切换 `current` → `docker compose ... up -d --build --wait` → 健康检查 / A2A Agent Card / 容器 / Runner 心跳 / Nginx → OK/FAIL 汇总 |
| `e2e-remote.sh` | 服务器本机 e2e（直连 `127.0.0.1:8890`，不触发 Nginx 限流），只输出 PASS/FAIL：健康、工作台、管理后台密码登录与概览、真实模型任务（工具调用+审批+成果文件）、续聊、A2A card / send / stream / tasks/get、定时计划（创建/手动运行/历史/删除） |

```sh
bash deploy-c666abf.sh            # 部署（同目录有 e2e-remote.sh 时成功后自动跑 e2e）
bash deploy-c666abf.sh rollback   # 先备份，再切回部署前的 release 与 before-* 镜像
bash deploy-c666abf.sh status     # 只做检查
bash e2e-remote.sh                # 单独跑 e2e
```

- `data/`、`stack.env`、`accounts.txt` 只在 `/home/ubuntu/pig-agent/data` 与 Docker 卷中，脚本从不打印、复制或上传其内容；e2e 在进程内读取管理员账号，结束时注销会话，测试计划会删除。
- 有运行中任务时部署会停止（`FORCE=1` 跳过）。日志写入 `backups/deploy-*.log`（0600）。
- 回滚不恢复数据库：c666abf 没有新增表结构迁移。只有确需回到部署前数据时，才单独确认并用 `backups/before-20261008-p0p2-c666abf/*.dump` 恢复（会覆盖之后的新数据）。
- 可选：`CLOUD_DIST=asset` 直接用预构建产物；`NPM_REGISTRY=...` 更换构建用 npm 源；`SKIP_E2E=1`。
