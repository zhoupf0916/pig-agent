# 腾讯云单机部署

用于小规模内测，Ubuntu 上使用 Docker Compose 运行 PostgreSQL、控制面、模型网关和四个 Runner，宿主 Nginx 终结 HTTPS。不是高可用部署。桌面 Electron 安装在用户电脑上，不部署到服务器。

## 目录与启动

当前实例 193.112.22.18：4 vCPU、约 4 GB 内存、59 GB 磁盘。当前版本：`93e3eea` 基线加 2026-09-24 产品加固，release 为 `20260924-hardening`。

- `/home/ubuntu/pig-agent/releases/20260924-hardening`：源码和预构建 `cloud-dist`。
- `/home/ubuntu/pig-agent/current`：指向当前 release 的符号链接。
- `/home/ubuntu/pig-agent/data/cloud-local/stack.env`：数据库、内部认证与加密配置，权限 0600，不能提交 Git。
- 同目录 `accounts.txt`：已有管理员凭据，部署保留账号，不重新生成密码。

首次部署在可信构建机执行 `pnpm install --frozen-lockfile && pnpm cloud:build`，将源码与 `cloud-dist` 上传 release 目录。首次环境需按 [本地云平台](local-cloud.md) 生成独立配置与管理员，不能复制开发环境数据库或共享管理员凭据。升级已有环境先备份数据库和配置。

```sh
cd /home/ubuntu/pig-agent/current
# 后续命令沿用同一个 Compose 项目名，不能意外新建空数据库卷。
docker compose --env-file /home/ubuntu/pig-agent/data/cloud-local/stack.env \
  -f infra/cloud/compose.yml -f infra/tencent/compose.yml up -d --build --wait
```

覆盖文件配置四个 Runner，每节点并发 1、内存 768 MiB、CPU 1 核；仅接收 compact/standard 任务。控制面和数据库各 512 MiB，网关 256 MiB。管理后台全局并发设置为 2，用户和项目并发均为 1，队列长度 30，排队超时 1800 秒。审批等待会占用执行名额。所有服务设置自动重启和轮转日志。

只有构建阶段使用 host 网络来下载软件包。运行期仍走 bridge；数据库和 Runner 仅接内部网络，网关与控制面允许出站访问模型/MCP。任务使用 Bubblewrap + seccomp，沙箱失败拒绝执行，不挂载 Docker socket。

## HTTPS 与公网边界

腾讯云防火墙需要 TCP 80（证书验证）和 TCP 443（HTTPS）。数据库和 8890 不对公网开放，8890 只绑定宿主回环。SSH 沿用现有访问策略。

没有域名也可使用可信 IP 证书。使用 Certbot 5.4+ 与 Let's Encrypt shortlived profile：

```sh
sudo apt-get update
sudo apt-get install -y nginx python3-venv
sudo python3 -m venv /opt/pig-certbot
sudo /opt/pig-certbot/bin/pip install 'certbot>=5.4,<6'
sudo mkdir -p /var/www/pig-acme
# 先配置仅包含 HTTP ACME location 的 Nginx 站点，确认公网 80 可访问。
sudo /opt/pig-certbot/bin/certbot certonly --non-interactive --agree-tos \
  --register-unsafely-without-email --preferred-profile shortlived \
  --webroot --webroot-path /var/www/pig-acme \
  --ip-address 193.112.22.18 --cert-name 193.112.22.18
# 签发后安装 infra/tencent/nginx.conf，替换 IP 与证书路径以匹配新实例。
sudo nginx -t
sudo systemctl reload nginx
```

`WEB_PUBLIC_ORIGIN=https://193.112.22.18` 必须写入 stack.env 后重建控制面。Nginx 禁止公网访问 `/internal/`，关闭响应缓冲以支持 SSE，HTTP 自动跳转 HTTPS。登录 cookie 为 Secure + HttpOnly。

IP 证书只有约六天有效期。安装 `pig-cert-renew.service` 与 timer 到 `/etc/systemd/system/`，安装 `renew-hook.sh` 到 `/etc/letsencrypt/renewal-hooks/deploy/pig-nginx` 并赋予执行权限，然后启用 timer。每六小时检查续期；80 端口不能关闭。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pig-cert-renew.timer
sudo /opt/pig-certbot/bin/certbot renew --dry-run --no-random-sleep-on-renew --run-deploy-hooks
```

官方说明：[Let's Encrypt 的 IP 证书与 Certbot 支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

## 模型与备份

管理员在模型渠道设置 DeepSeek 或兼容渠道，连接测试成功后启用。渠道密钥加密保存在数据库；必须同时备份 stack.env 中的加密密钥。当前使用 DeepSeek `deepseek-chat`，`MODEL_MODE=provider`，未把 API key 烘焙到镜像。

安装 `pig-backup.service` 和 timer 到 `/etc/systemd/system/`，为 `backup.sh` 增加执行权限，启用 `pig-backup.timer`。每天 03:30 UTC 附近保存 pg_dump 自定义格式与加密配置备份，权限 0600；归档只在成功校验后改为正式文件名。

```sh
sudo systemctl enable --now pig-backup.timer
sudo systemctl start pig-backup.service
sudo systemctl list-timers 'pig-*'
```

备份位于 `backups/daily`，不自动删除；管理员需要监测磁盘并安排异地备份。同服务器备份无法抵御服务器或磁盘丢失。模型密钥、密码、备份与账户文件不能提交 Git，也不能放到 Nginx 静态目录。

## 排障与回滚

```sh
cd /home/ubuntu/pig-agent/current
docker compose --env-file /home/ubuntu/pig-agent/data/cloud-local/stack.env \
  -f infra/cloud/compose.yml -f infra/tencent/compose.yml ps
# 同样的 compose 前缀后使用 logs --tail=100 cloud worker gateway
sudo journalctl -u nginx -u pig-cert-renew -u pig-backup --since today
curl --connect-to 193.112.22.18:443:127.0.0.1:443 https://193.112.22.18/health
```

宿主本地 HTTPS 正常但公网失败，先检查腾讯云 **IPv4** TCP 443；只放行 IPv6 不够。页面正常但任务排队，检查 Runner 心跳、并发和审批占位。模型错误先在后台测试渠道，不能通过取消沙箱解决。

本次升级前备份保存在 `backups/20260924/`；旧镜像打标 `before-20260924`。回滚需要先停止接收任务、备份当前数据，再恢复匹配版本的代码、配置和数据库。不要仅切旧镜像连接已迁移数据库，也不要执行 `docker compose down -v`。数据库恢复会覆盖新数据，必须单独确认后执行。

## 验证记录（2026-09-24）

已通过内部部署验收：登录 cookie、跨账号任务隔离、审批暂停、重复审批返回 409、Runner 沙箱写文件、成果下载内容验证、等待审批时取消。证书真实签发成功，宿主 HTTPS 验证正常，续期 dry-run 和部署 hook 成功。数据库备份服务实际执行成功。

真实 DeepSeek 渠道连接测试返回 200，任务 `run_7854fd434c91412a86a37e84b8669af3` 通过 Runner 成功回复 `PIG_DEPLOYMENT_OK`；模型首 token 423 ms，模型调用 468 ms，API 轮询观察到完成约 1.1 s。这是一条短回复的观测，不代表负载性能。

公网 IPv4 TCP 443 已经用户确认后放行。外部 HTTPS 返回 200，`/internal/` 返回 404，真实浏览器登录成功并完成对话「公网对话已连通」。管理端显示真实模型渠道、两个在线 Runner 和两个执行槽位。旧 `pig-worker-local` 已停用，保留历史记录。SSE 在公网返回 `text/event-stream`，收到 1270 字节首块；开启限流后仍可正常登录。

### 公网限流

Nginx 基于真实连接来源 IP（`$binary_remote_addr`），不信任客户端自带的 X-Forwarded-For：

- `/v1/`：每 IP 每秒 10 次，额外突发容量 30。
- 登录、注册和邀请接口：每 IP 每分钟 5 次，额外突发容量 5。
- HTTPS 每 IP 最多 40 个并发请求/连接（包括长时间 SSE）；静态文件不计 API 请求频率。
- 超限统一返回 429、JSON 提示和 `Retry-After: 15`；限制请求头/请求体读取超时。
- SSE 只在建立请求时计频率，不限制每个 token；全局任务并发为 2、单用户与项目并发为 1。

先运行未加固基线：100 次未登录 API 突发全部返回 401，限流断言失败；配置部署后 36 次返回 401、64 次返回 429。12 次空登录请求中 6 次返回 400、6 次返回 429，逐请求伪造转发 IP 无法绕过。上述为单 IP 短时本地验收，不是容量或 DDoS 测试。

复验脚本：`node infra/tencent/check-rate-limits.mjs https://193.112.22.18`。它会发起 100 次未登录 GET 和 12 次空登录 POST，适合维护窗口运行，可能短暂限制同一 NAT 下的其他用户。截图与详细结果保存在本机 `data/tencent-deploy/public-chat.png`、`public-admin.png` 和 `public-verification.json`，不进入 Git。

这是单机入口限流，同一出口 IP 的用户共享额度，不能防御分布式攻击或上游带宽耗尽。扩容到多入口或大量公网用户前，需要共享配额和边缘防护方案；当前不宣称具备此能力。

## 网关 DNS 与联网审批

腾讯云部署使用 `NETWORK_DNS_MODE=system`。本地开发平台的 public 模式固定访问 Cloudflare DoH，在本服务器上会超时；不要直接照搬。system 模式仍校验全部返回的 IPv4，拒绝私网、元数据和本机地址，并将 HTTPS 连接固定到验证过的公网 IP。

用户批准的是单个 `http_fetch` HTTPS GET，不是开放 shell 网络。审批后失败需重新申请，不会自动复用授权。运维可运行 `VERIFY_ENV=/home/ubuntu/pig-agent/data/cloud-local/stack.env node scripts/verify-approved-network.mjs`，它创建一个独立管理员验收任务，只批准腾讯主页的单次 GET，调用真实模型并保存证据。此验证会消耗少量模型额度，常规回归优先使用模拟模型。

单机容量实测、限制和复现命令见 [容量评估](capacity-review-2026-09-24.md)。

## 2026-09-24 扩容到四个 Runner

新增 runner-c / runner-d，节点名 pig-tencent-runner-c / pig-tencent-runner-d。四个节点均已注册、启用、单槽，心跳检查距当前不超过 1 秒，新增节点日志为 Worker pool ready。全局任务并发保持 2，单用户/项目仍为 1；四个节点共享两个执行名额，不等于四任务同时执行。未重启已有 Runner、控制面或数据库。控制面健康检查通过。

恢复为两个节点时先等待新增节点任务完成，再执行 Compose stop runner-c runner-d，并在管理端停用对应节点；不要直接中断执行中的任务。
