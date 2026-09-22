# 给开发 Agent 的规范

改代码前先读 [架构说明](docs/architecture.md)。本文件只写怎么改、怎么验证。产品边界以架构说明为准。

## 先写失败的测试

鉴权、密钥、取消、重试、审批和数据一致性，先写一个会失败的行为测试，再写实现。测试要断言用户能观察到的结果：状态码、错误文案、数据库里的终态、是否执行了写入。不要为了凑覆盖率去测私有函数的调用顺序。

界面文案、间距和颜色不写实现镜像测试。交互变了，用现有的浏览器冒烟脚本核对真实页面。

测试放在被测代码旁边，文件名 `*.test.ts`。根目录 `pnpm test` 会跑 `apps/**/src/**/*.test.ts`。`tests/setup.ts` 会把数据目录指到临时目录，并清掉模型密钥和环境变量。测试不要读仓库里的 `.env`，不要连开发者本机的数据库或真实模型。

一个行为一个 `it`。名字写成会失败时能看懂的句子，例如「被拒绝的申请可以重新提交」。

## 改动顺序

1. 协议字段先改 `packages/contracts`，再改生产和消费它的代码。不要在应用里复制一份 DTO。
2. 应用只依赖 `@pig-agent/contracts` 的导出。Web 不引用 server，server 不引用 Web 或 Electron，cloud 不引用本机 JSON 存储。
3. 运行依赖放在所属应用。只有多个应用都要用的开发工具才放根 `package.json`。
4. 不为了分层加只做转发的 service、repository、manager。现有大文件按业务域拆开时，保留原来的取消、重试和交付测试。
5. 改了路径，同时改构建、测试、CI 和对应文档。

提交前对刚改的测试文件执行 `pnpm exec vitest run <文件>`。跨包改动再跑：

```bash
pnpm check:architecture
pnpm typecheck
pnpm test
```

云端冒烟（`pnpm cloud:smoke*`）需要已经启动的本地 Docker 平台，默认用模拟模型。不要为了看界面反复打真实模型。

## 安全边界

- 登录、注册、会话和密码只保存哈希。测试和日志里不出现明文密码、API Key、管理员令牌。
- 未批准的注册不能登录。拒绝后的申请可以重新提交；待审核和已停用要返回各自的说明，密码错误仍只说账号或密码不正确。
- 沙箱失败就拒绝执行，不降级成直接在主机上跑命令。
- 不把 `data/`、`.env*`、`accounts.txt`、密钥和安装包提交进 Git。

## 提交

提交说明用英文，一行说清原因。常用前缀：`feat`、`fix`、`docs`、`test`、`refactor`。

```text
fix: let rejected applicants reapply and explain review state
```

只提交这次任务相关的文件。用户没有明确说推送时，不推远程。
