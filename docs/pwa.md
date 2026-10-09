# 可安装工作台（PWA）

云端 Web 工作台可以安装到桌面或手机主屏幕，以独立窗口打开。离线时能进入应用外壳；在后台时，任务完成、失败或需要审批会发通知。

## 组成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| Manifest | `apps/web/public/manifest.webmanifest` | `display: standalone`，`start_url: /?source=pwa`，192/512 图标与 512 maskable 图标 |
| 图标 | `apps/web/public/icons/` | 由 `apps/desktop/assets/icon.icns` 派生；`apple-touch-icon.png` 为不透明满版 |
| Service Worker | `apps/web/src/pwa/sw.ts` | 构建时由 `scripts/pwa-plugin.ts` 打包为 `dist/sw.js`，写入构建版本与入口资源清单 |
| 缓存策略 | `apps/web/src/pwa/sw-policy.ts` | 纯函数，单元测试覆盖 |
| 注册与界面 | `apps/web/src/pwa/pwa.ts`、`PwaUpdateToast.tsx`、`PwaSettingsCard.tsx` | 仅云端生产构建、安全上下文且非桌面客户端时注册 |
| 服务端 | `apps/cloud/src/index.ts` | `/sw.js`（`Cache-Control: no-cache`，`Service-Worker-Allowed: /`）、`/manifest.webmanifest`、`/icons/*` |

## 缓存只包含静态外壳

- 导航请求 `/`：网络优先，离线时回退到缓存的 `index.html`。部署后打开即为新版本。
- `/assets/*`（文件名带内容哈希）：缓存优先。
- `/icons/*`、manifest：先返回缓存，后台刷新。
- **永不缓存**：`/v1/`、`/auth/`、`/internal/`、`/admin`、`/api/`、`/debug`、`/openapi.json`、`/health`、`/.well-known/`、`/sw.js` 以及所有非 GET、跨域请求。账号数据、会话、附件和 SSE 流不会进入 Cache Storage，退出登录无需清缓存。
- 缓存名 `pig-shell-<构建版本>`；新 Worker 激活时只删除旧的 `pig-shell-*`。

## 更新

每次构建生成新版本号（所有产物文件名的哈希），`sw.js` 内容随之变化。浏览器检测到新 Worker 后，页面底部显示「工作台有新版本 · 刷新」，点击后新 Worker 接管并重新加载。首次安装不提示。已安装的应用每小时以及回到前台时检查更新。

## 安装与通知

设置 → 偏好设置 → 「应用与通知」：

- Chromium（Android/桌面）：浏览器提供安装入口时显示「安装」按钮。
- iOS Safari：提示「分享 → 添加到主屏幕」。
- 通知需用户点击「开启通知」授权；偏好保存在 `localStorage`（`pig-agent.notify`）。仅当工作台处于后台时提醒，点击通知回到对应会话。后台时审批轮询放慢到每 10 秒，且仅在开启通知时进行。

离线打开已安装的应用会显示「当前离线」，网络恢复（`online` 事件或每 15 秒重试）后自动连接，不会误显示登录页。

## 限制

- 只有工作台在运行（前台或后台标签页、已安装窗口未关闭）时才能提醒。应用完全关闭后的推送需要 Web Push（VAPID + 浏览器推送服务）；国内 Android Chrome 依赖的 FCM 不可达，暂不实现。
- Service Worker 需要可信 HTTPS。生产使用 Let's Encrypt IP 证书（由 `pig-cert-renew.timer` 续期）；证书失效时浏览器会拒绝注册 Worker，但网页本身仍按原方式工作。

## 验证

- 单元测试：`apps/web/src/pwa/sw-policy.test.ts`、`pwa-state.test.ts`。
- 线上 e2e：`scripts/deploy/e2e-remote.sh` 的「installable app (PWA)」检查 manifest、图标、`sw.js` 响应头、版本号、当前入口包是否在预缓存清单中，以及永不缓存列表。
- 浏览器验收（Playwright，Chromium）：页面被 Worker 控制；缓存只有外壳与入口资源；无安装性错误；离线打开显示离线提示并在恢复后自动连接；后台时审批与完成通知均弹出且指向正确会话。
