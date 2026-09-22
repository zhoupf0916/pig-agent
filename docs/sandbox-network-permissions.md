# 沙箱与单次网络权限

## 实际执行边界

桌面本机 Pig 固定使用操作系统沙箱（macOS Seatbelt，Linux bubblewrap 与 seccomp）。保存为宿主机或 Docker 的旧策略在重新打开时改回原生沙箱；沙箱打不开就拒绝执行，不改到本机进程。网络开关默认关闭。打开后只放行沙箱出站，工作区之外的文件隔离保持不变。

Web 任务始终由控制面调度到独立 Runner 容器，不能通过关闭沙箱访问控制面或 Worker 宿主机。容器保持独立 Internal 网络、非 root 用户、只读根文件系统、资源限制和临时工作区。网关是独立可信代理，连接 egress 网络；不会给执行容器接公网网络或挂载 Docker socket。

## 从网络受限到申请

云端输入 `networkPolicy` 为 `ask` 或 `blocked`，默认 `ask`。`ask` 表示每次 `http_fetch` 都需用户批准，不等于默认联网；`blocked` 不生成申请，直接返回禁止访问。已有会话后续轮次继承初始策略。Shell 网络失败时，模型提示使用指定 URL 的 `http_fetch` 申请，不会自动重跑带公网权限的 Shell。

单次权限精确绑定 URL、GET 方法、超时和响应上限，独立于写入审批开关。批准后网关向控制面原子领取一次权限，再读取目标。只支持 HTTPS 443，不转发认证信息、Cookie 或调用者请求头。DNS 只接受公网 IPv4，HTTPS 连接固定使用已验证地址，保留 TLS 主机验证；拒绝私网、回环、元数据、保留地址及 IPv6。默认最多 10 秒、200KB，可在单次申请内缩小/调整至 15 秒、400KB 上限。重定向不会自动跟随，新 URL 必须重新申请。

拒绝不访问目标。取消或撤权使等待/正在读取终止；控制面在领取时检查任务租约、期限、账户、Worker 及项目写权限，网关读取期间每 500ms 重验运行凭证。已消费权限不能重放；超时或失败也不会自动再次 GET。网络请求已发出后的取消不能撤销远端服务器已接收的请求，因此仅允许 GET。

桌面本机工作台的 `http_fetch` 同样总是进入单次审批，即使关闭写入审批。批准后由现有受限 HTTP 读取器执行，不开启 Shell 网络；可拒绝、取消且不可重复批准。桌面该读取器保留现有 HTTP(S) 范围，云端代理采用上述更严格 HTTPS 443 边界。

## 本地代理 DNS

`NETWORK_DNS_MODE=system` 为代码默认值，使用系统 DNS 并拒绝私网/保留地址，不会自动放宽。如果宿主代理开启 Fake-IP，域名可能解析成 `198.18.0.0/15`，系统模式会正确拒绝访问。

两套本地 Docker compose 显式设置网关 `NETWORK_DNS_MODE: public`：批准精确目标之后，通过固定 `https://1.1.1.1/dns-query` 使用经过 TLS 验证的 DNS-over-HTTPS 获取 A 记录，超时 4 秒、响应 16KB 上限。解析结果仍需通过公网 IPv4 校验再绑定连接；不依赖 Fake-IP DNS，不允许配置任意解析器地址。该模式会向 Cloudflare DNS 服务发送已批准目标的域名。部署环境可显式改回 `system`，不提供不验证地址的模式。

## 验证与发现

`pnpm exec vitest run apps/cloud/src/network-fetch.test.ts apps/server/src/agent/runtime.test.ts apps/server/src/routes/workbench.test.ts` 覆盖 DNS 绑定、私网拒绝、响应截断、不转发凭证、重定向不跟随、无效重定向、DNS 等待取消、固定公网解析器，以及关闭写入审批仍需网络审批。

`node scripts/smoke-cloud-network.mjs` 使用本地 8892 双控制面/双 Runner 和明确的模拟模型场景：真实容器直接 HTTPS 探测失败；浏览器批准单次 GET 后真实读取 example.com；拒绝、blocked、取消、旧审批、URL 改写、SSRF 和重复领取均有实际 API/数据库验证。脚本保存 Chrome 桌面及手机审批截图、结果 JSON 到 `data/network-evidence/`。不使用真实模型额度。

实现过程中实际发现并修复：集群网关最初没有 egress，公网 DNS 失败；增加仅网关的外网出口后，又发现宿主 Fake-IP DNS 返回保留地址，遂加入显式可信公网解析模式。专项模拟器也修复了工具失败后内部提示覆盖原测试标记的问题。以上不是通过放宽隔离或跳过失败来处理。

2026-09-22 最终实际验证通过：`docs/evidence/network-2026-09-22/checks.json` 记录全部五组场景；两张截图展示真实桌面与手机审批卡的 URL、单次 HTTPS GET 范围、批准和拒绝按钮。公网域名 `https://example.com/` 在明确 public DNS 模式下经批准成功返回 `Example Domain`，容器直接联网仍失败。此前还验证了公网 IP 地址的批准 GET，最终验收不依赖 IP 替代域名。
