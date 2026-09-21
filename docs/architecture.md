# 架构与仓库治理

## 应用边界

| 模块 | 职责 | 不应承担 |
| --- | --- | --- |
| `apps/web` | React UI、交互状态、HTTP / SSE 客户端 | Node 文件系统、密钥持久化、执行器实现 |
| `apps/server` | API、任务编排、工具、运行时适配、本机存储 | Electron 窗口、React 组件、未来云端租户管理 |
| `apps/desktop` | 原生窗口、目录选择、系统密钥存储、服务启停、分发 | 重写 Agent 逻辑、复制一套工作台 |
| `packages/contracts` | API 数据结构、事件和 Cloud 协议 | Node / Electron / React 依赖、运行时密钥、数据库访问 |

依赖方向：Web → contracts；server → contracts；桌面通过构建产物启动 server，通过受限 preload 桥服务 Web。应用之间不直接导入源码。共享包使用 `@pig-agent/contracts` 与 `@pig-agent/contracts/cloud` 的显式导出。

`pnpm check:architecture` 检查跨包源码引用、应用相互引用、浏览器 Node API 和契约包的平台依赖，`pnpm build` 与 CI 都会执行。pnpm workspace 管理各应用的运行依赖；根包只保留共享开发工具与命令编排。

`apps/*/src/types.ts` 是兼容入口：服务端保留执行选项与本机身份常量，Web 保留瞬时 UI 状态。持久数据、API 事件和 Cloud 协议集中在 contracts，避免前后端维护两份同名类型。

## 服务端现有分层

- `routes/`：HTTP 输入校验与响应；核心路由仍在 `app.ts`，后续按业务域逐步移出。
- `store/`：本机持久化与一致性规则。
- `agent/`：执行循环、工具与 Pig / Codex / Cloud 适配器。
- `automations/`：定时调度；由可执行入口显式启动。
- `desktop/` 与 `desktop.ts`：桌面宿主的鉴权、模型连接测试和父进程协议。
- `index.ts`：独立 Web 服务入口。

当前仍有较大的 `App.tsx`、`app.ts` 和执行模块。本次先建立应用与协议边界；后续按业务域拆分这些文件时，需要保留现有消息一致性、取消、重试和交付回归测试。不要为了目录层数引入只有转发作用的 service / repository / manager。

## 云端演进

当前 `apps/server/src/agent/cloud` 是 Cloud **消费端适配器**，`local-stub` 用于本机验证，`remote` 对接已有控制面。它不是可部署的多租户云平台。

当前已新增 `apps/cloud`（PostgreSQL 控制面）、`apps/worker`（可信容器调度）和 `apps/admin`（独立管理界面）；第一批范围见 [本地云平台](local-cloud.md)。它们通过 `contracts/cloud` 协议接入，未复用本机 JSON store 或暴露本机 API。执行镜像目前构建自 server 内的专用入口，复用现有 Pig 循环；共享 agent-core 提取将在下一批按实际依赖完成。云端需要显式建设身份认证、租户隔离、任务队列、对象存储、模型网关、配额与审计。只有出现第二个真实使用方时，才将平台无关的编排逻辑提取为共享包；文件系统、进程、密钥和网络权限通过各宿主适配。

不预建空的 cloud 应用或抽象框架，以免让占位代码看起来像已实现能力。

## 路径与数据

仓库根目录由服务端配置统一解析；Cloud hint 读取复用同一个根目录。移动应用后，源码模式的数据与样例目录保持在仓库根目录。桌面 bundle 使用明确的资源根目录与独立 userData，不依赖启动时的终端目录。

构建输入采用白名单：编译后的服务端、Web 静态产物和内置 skills。`data/`、`.env*`、开发工作区、诊断和安装包不会进入应用资源或 Git。

## 修改规则

1. 改 API 字段先改 contracts，然后同步生产者与消费者；不要复制 DTO。
2. 运行依赖放所属应用，跨应用公用的开发工具放根包。
3. 不从 Web 导入服务端文件，不通过 `../../` 绕过包导出。
4. 保持根目录脚本可用；改路径同时改构建、测试、CI 与文档。
5. 对鉴权、密钥、取消与数据一致性增加行为测试，UI 文案与低风险布局不堆实现镜像测试。
