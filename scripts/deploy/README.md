# 服务器自拉取部署（腾讯云）

在服务器上以 `ubuntu` 执行，服务器自己从 GitHub 拉取公开源码；不需要从构建机上传，也不经过任何第三方文件托管。

| 文件 | 作用 |
| --- | --- |
| `deploy.sh <commit>` | 下载 `<commit>` 源码到 `releases/<yyyymmdd>-<sha7>` → 备份数据库+配置并校验 → 在 `node:24` 容器内构建 `cloud-dist`（失败时下载 `deploy-<sha7>` release 资产并按其 SHA256SUMS 校验；有参考树哈希时比对）→ 旧镜像打 `before-<release>` 标签 → 切换 `current` → `docker compose ... up -d --build --wait` → 健康 / 容器 / Runner 心跳 / 工作台 / 后台 / A2A Agent Card（公网 origin 为 https 时必须宣告 https）/ Nginx → OK/FAIL 汇总 |
| `deploy.sh rollback` | 先备份，再切回上一次部署前的 release 与 `before-*` 镜像；提示 schema 文件是否变化，不自动恢复数据库 |
| `deploy.sh status` | 只做检查 |
| `e2e-remote.sh` | e2e，只输出 PASS/FAIL：健康、工作台、管理后台密码登录与概览、真实模型任务（工具调用+审批+成果文件）、续聊、A2A card（含 https URL 校验）/ 匿名 401 / send / stream / tasks/get、定时计划（创建/手动运行/历史/删除） |
| `cert-check.sh [host]` | 只读证书报告：ACME 客户端（certbot / acme.sh / lego / caddy）、systemd timer / cron、最近续期日志、证书 notAfter、续期后是否重载 Nginx（hook + 在线证书序列号是否等于磁盘证书）。不续期、不 dry-run、不重载，不读私钥 |

```sh
bash deploy.sh <commit-sha>      # 部署（同目录有 e2e-remote.sh 且服务器上有管理员密码时，成功后自动跑 e2e）
bash deploy.sh rollback          # 回到上一次部署前的 release
bash deploy.sh status
bash e2e-remote.sh               # 在服务器本机跑（直连 127.0.0.1:8890，不触发 Nginx 限流）
# 在其他机器上对公网地址跑（默认每请求间隔 150ms；只尝试一次登录）
PIG_BASE=https://193.112.22.18 PIG_REMOTE_ADMIN_USER=admin PIG_REMOTE_ADMIN_PASSWORD=*** bash e2e-remote.sh
bash cert-check.sh
```

- `data/`、`stack.env`、`accounts.txt` 只在 `/home/ubuntu/pig-agent/data` 与 Docker 卷中，脚本从不打印、复制或上传其内容；e2e 在进程内读取管理员账号，结束时注销会话，测试计划会删除。
- 账号来源：`PIG_REMOTE_ADMIN_USER` / `PIG_REMOTE_ADMIN_PASSWORD` 环境变量优先，其次 `accounts.txt`（`Username:` / `Password:` 行，用户名默认 `admin`）；都没有时输出一条 FAIL 并停止。`PIG_INSECURE_TLS=1` 仅用于已知自签名主机。
- 有运行中任务时部署会停止（`FORCE=1` 跳过）。日志写入 `backups/deploy-*.log`（0600）。
- 回滚不恢复数据库。只有确需回到部署前数据时，才单独确认并用 `backups/before-<release>/*.dump` 恢复（会覆盖之后的新数据）。
- 可选：`CLOUD_DIST=asset` 直接用预构建产物；`NPM_REGISTRY=...` 更换构建用 npm 源；`SKIP_E2E=1`。
