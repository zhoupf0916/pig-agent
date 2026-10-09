# 服务器自拉取部署（腾讯云）

在服务器上以 `ubuntu` 执行，服务器自己从 GitHub 拉取公开源码；不需要从构建机上传，也不经过任何第三方文件托管。

| 文件 | 作用 |
| --- | --- |
| `deploy.sh <commit>` | 下载 `<commit>` 源码到 `releases/<yyyymmdd>-<sha7>` → 备份数据库+配置并校验 → 在 `node:24` 容器内构建 `cloud-dist`（失败时下载 `deploy-<sha7>` release 资产并按其 SHA256SUMS 校验；有参考树哈希时比对）→ 旧镜像打 `before-<release>` 标签 → 切换 `current` → `docker compose ... up -d --build --wait` → 健康 / 容器 / Runner 心跳 / 工作台 / 后台 / A2A Agent Card（公网 origin 为 https 时必须宣告 https）/ Nginx → OK/FAIL 汇总 |
| `deploy.sh rollback` | 先备份，再切回上一次部署前的 release 与 `before-*` 镜像；提示 schema 文件是否变化，不自动恢复数据库 |
| `deploy.sh status` | 只做检查 |
| `e2e-remote.sh` | e2e，只输出 PASS / FAIL / BLOCKED-402（模型服务返回 402 余额不足，属于账号问题，不计为失败）：健康、工作台、管理后台密码登录与概览、真实模型任务（工具调用+审批+成果文件）、续聊、A2A card（含 https URL 校验）/ 匿名 401 / send / stream / tasks/get、定时计划（创建/手动运行/历史/删除） |
| `deploy.sh <commit> --source-tar <file.tgz>` | 同上，但源码来自上传的压缩包（需同目录 `<file>.sha256`，校验不一致即停止）；此模式完全不访问 GitHub |
| `pack-source.sh <commit> [out-dir]` | 在有 git 仓库的机器上运行：`git archive` 打包该 commit（前缀 `pig-agent-<完整 SHA>/`，不含约 49 MB 的 `docs/`，构建和运行都不用），约 1.4 MB，并生成 `.sha256`，打印上传和部署命令 |
| `cert-check.sh [host]` | 只读证书报告：ACME 客户端（certbot / acme.sh / lego / caddy）、systemd timer / cron、最近续期日志、证书 notAfter、续期后是否重载 Nginx（hook + 在线证书序列号是否等于磁盘证书）。不续期、不 dry-run、不重载，不读私钥 |

后台一行部署：脚本取自目标 commit 本身，与浏览器终端断开无关。把 `S` 换成 main 的完整 SHA：

```sh
S=<full-sha>; cd /home/ubuntu/pig-agent && mkdir -p tools/$S && curl -fsSL https://codeload.github.com/zhoupf0916/pig-agent/tar.gz/$S | tar -xz -C tools/$S --strip-components=3 --wildcards '*/scripts/deploy/*' && (setsid nohup bash tools/$S/deploy.sh $S > backups/deploy-${S:0:7}.out 2>&1 < /dev/null &) && echo "tail -f /home/ubuntu/pig-agent/backups/deploy-${S:0:7}.out"
```

**推荐（服务器访问 GitHub 很慢或卡住时）**：在构建机打包上传，服务器不再访问 GitHub。实测：服务器 codeload 约 70 KB/s，46 MB 源码包下载约 10 分钟以上并卡住；精简包 1.4 MB，scp 约 90 秒。

```sh
# 构建机（仓库根目录，已 git fetch）
bash scripts/deploy/pack-source.sh <full-sha> /tmp/pack
scp /tmp/pack/pig-src-<sha7>.tgz /tmp/pack/pig-src-<sha7>.tgz.sha256 ubuntu@<server>:/home/ubuntu/pig-agent/uploads/
# 服务器
S=<full-sha>; cd /home/ubuntu/pig-agent && mkdir -p tools/$S && tar -xzf uploads/pig-src-${S:0:7}.tgz -C tools/$S --strip-components=3 --wildcards '*/scripts/deploy/*' && (setsid nohup bash tools/$S/deploy.sh $S --source-tar uploads/pig-src-${S:0:7}.tgz > backups/deploy-${S:0:7}.out 2>&1 < /dev/null &) && echo "tail -f /home/ubuntu/pig-agent/backups/deploy-${S:0:7}.out"
```

GitHub 下载（codeload、release 资产）在速度低于 1 KB/s 持续 60 秒时中止，不会无限挂起。

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
