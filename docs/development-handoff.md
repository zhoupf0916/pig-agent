# 开发接手记录（2026-09-21）

## 接手依据

已读取 Grok Bot 的「猪扒饭」「猪扒·研发」「猪扒·产品」「猪扒·交付」对话，并核对 GitHub PR #71：

- BE 已完成并合入 `main`：`a2b44aa40b9f152c4c711d857610abdd9cd76cc0`。
- 当前工作是 BF：另一标签删除待办后，清除当前项目 URL 中失效的 `?todo=` 高亮。
- [PR #71](https://github.com/zhoupf0916/pig-agent/pull/71) 尚未合并，接手时 head 为 `5148d3916bf3d8c31f29f362ac98294230b07da1`。
- Cursor 云端额度中断了验证与交付收尾。原产品范围仍为 MANUAL_TEST.md 的 BF-01～BF-04；`teamRun.members`、活动记录正文清理等不属于本次范围。

本地接续分支：`codex/bf-handoff`，基于上述 PR head。用户已要求 Codex 接手开发，旧 bot 的 Cursor 云端执行限制不作为本地开发前置条件。

## 本轮修复

BF 原实现会在项目切换后的首轮渲染中，用上一项目尚未更新的 `detail.todos` 判断新项目的 `?todo=`，从而误清有效高亮。

新增 `shouldClearOpenTodoHighlight`，仅在详情的项目 ID 与当前选中项目一致、且快照确认待办不存在时清除高亮。既有同步回调与详情 effect 共用此判断。仍复用原轮询，保留 `?asset=`，没有新增 API。

回归测试覆盖上一项目详情、尚未取得详情、未选择项目、无高亮、目标待办存在，以及目标项目确认待办已删除。

## 验证结果

- 全量 Vitest：71 个文件、542 项测试通过。
- 服务端与前端 TypeScript 检查通过。
- Vite 生产构建通过。
- `git diff --check` 通过。

本机预装 pnpm 11 不识别仓库的 `pnpm.onlyBuiltDependencies`，安装后报 esbuild 构建许可错误。依赖与原生二进制已下载；本轮直接运行已安装的工具入口验证，没有改依赖清单或锁文件。

第一次并行测试有 12 项失败：macOS `/var` 与 `/private/var` 临时目录别名导致路径断言/产物路径失败，且共用设置文件导致工作区相互覆盖。规范化临时目录、使用独立 DATA_DIR 并串行执行测试文件后全量通过。未在 BF 中修改这些既有测试/运行时问题。

复现命令（先确保 Node 在 PATH 中）：

```sh
export TMPDIR="$(cd "$TMPDIR" && pwd -P)"
export DATA_DIR="$(mktemp -d "$TMPDIR/pig-bf-tests-XXXXXX")"
node node_modules/vitest/vitest.mjs run --no-file-parallelism
node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit
node node_modules/vite/bin/vite.js build --config web/vite.config.ts
```

## 交付状态

用户随后授权继续完成项目闭环。Codex 已在本机独立数据目录、8797 端口完成 Chrome 双标签实测：A 新建并删除待办，B 先打开有效 `?todo=`，恢复焦点后看板条目和查询参数自动清除，无整页刷新。顶栏仍为本机 Pig，页面布局正常，活动历史按原设计保留。可见页面没有密钥内容；本轮没有配置真实 Provider Key。

BF-02 的 API/轮询约束通过代码复核和自动化验证确认；`?asset=` 保留和跨项目高亮保护有回归覆盖。以上是 Codex 本轮验收，不代表历史产品/UI bot 已签收。PR 按接手后的验证结果收尾；未向 bot 或交付群发送消息。
