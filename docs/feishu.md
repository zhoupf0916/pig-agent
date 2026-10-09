# 飞书机器人（F3）

在飞书（中国版 open.feishu.cn）里私聊机器人，或在群里 @机器人，即以绑定的工作台账号执行任务并把结果回复到原消息。

**默认关闭**：只有同时设置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 才会启动（`FEISHU_ENABLED=0` 可强制关闭）。关闭时不加载 SDK、不建立连接，工作台不显示飞书卡片，`POST /v1/feishu/bind-code` 返回 404。

## 飞书开放平台配置

1. 创建「企业自建应用」，开启「机器人」能力。
2. 权限：`im:message`、`im:message.p2p_msg:readonly`（接收单聊消息）、`im:message.group_at_msg:readonly`（接收群聊中 @机器人 的消息）、`im:message:send_as_bot`（以应用身份发消息）。
3. 事件与回调 → 订阅方式选择 **使用长连接接收事件**，添加事件 `im.message.receive_v1`。长连接不需要公网回调地址。
4. 发布版本，把 App ID / App Secret 写入服务器 `stack.env`，重新部署或重启 cloud 容器。

## 使用

- 工作台「设置 → 偏好」出现「飞书」卡片 → 生成一次性绑定码（10 分钟有效、只能用一次）→ 在飞书里**私聊**机器人发送 `/bind 绑定码`。群里发送绑定码会被拒绝。
- 一个飞书身份对应一个工作台账号；重新绑定会替换旧绑定。连续 5 次绑定码错误暂停 10 分钟。
- 私聊每条消息都处理；群聊只处理 @机器人 的消息，且每个成员有自己的会话，互不共享工作区。
- 同一聊天里的后续消息接着上一个会话继续；`/new` 开始新会话，`/unbind` 解除绑定，`/help` 帮助。
- 任务默认需要审批：遇到需要确认的操作时回复工作台链接；结束时回复最终答案（超过 3500 字截断）和工作台链接；超过 60 分钟未结束则回复工作台链接。

## 实现

- `apps/cloud/src/feishu/`：`text.ts`（纯函数）、`service.ts`（绑定、事件处理、回复泵）、`client.ts`（官方 SDK `@larksuiteoapi/node-sdk` 长连接，仅启用时动态加载）、`routes.ts`（工作台接口）。
- 任务通过**公开 API** 在进程内以绑定账号身份发起：每次调用临时创建一条 5 分钟会话，调用结束立即删除，额度、并发、审批、权限与工作台一致。
- 按 `message_id` 去重（飞书会重投）；待回复记录持久化在 `feishu_replies`，重启后继续投递。
- 迁移 0010（只扩展）：`feishu_bindings`、`feishu_bind_codes`（只存哈希）、`feishu_chats`、`feishu_messages`、`feishu_replies`。
- 接口：`GET /v1/feishu`、`POST /v1/feishu/bind-code`、`DELETE /v1/feishu/binding`。
- 本地验收：`pnpm cloud:smoke:feishu`（模拟模型 + 假飞书传输）。
