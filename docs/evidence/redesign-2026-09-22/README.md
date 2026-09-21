# 重设计实际证据

[前后截图索引](index.html) 是入口。可按尺寸、主题和页面筛选；点击图片打开完整原图。[校验清单](archive-manifest.json) 包含归档文件大小与 SHA-256。

- 64 组同尺寸配对：54 组核心状态、10 组其余页面主体。
- 核心尺寸为 1440×900、1280×800、390×844，浅/深双主题。
- `before/manifest.json` 与 `after/workbench-matrix.json` 分别说明截图来源；UI 夹具不作为真实执行证明。
- `after/settings-check.json`、`after/pages-flow.json`、`after/session-context.json` 和 `admin/evidence.json` 记录真实浏览器操作。
- `final-product/` 仅包含最后一次完整组合冒烟的明确允许清单；管理端16项在2026-09-21T18:42:39.638Z完成。旧flow-debug等中间失败截图不在归档中。
- `real-flow/flow.json` 记录真实 mock 容器的创建、审批、下载、跟进、拒绝重试和取消。
- `cluster/control.json` 是双控制面14组协议场景，`cluster/runners.json` 是真实2×2节点故障与资源清理测试；模拟节点/时间戳注入与真实容器分开标注。
- `reliability/` 是完成交付故障注入与多控制面并发/代次证据。未归档 Runner outbox 或任何秘密配置。
- `artifact-source.json` 记录远端成果身份、本机同名隔离和显式导入验证。

`page-*` 的改版前截图是在新全局导航已完成、旧页面主体尚未重构时补拍；不等同完整旧版本。原管理端不支持深色，深色基线如实保留原表现。原始核心基线执行态可能在连续截图时进入等待审批；新版稳定执行态使用明确标注的 UI 夹具。详情见 [验收记录](../../redesign-acceptance-2026-09-22.md)。

归档未包含中间失败截图。已发现的真实缺陷和迭代过程仍记录在工作文档，并未以删除有效测试掩盖失败。
