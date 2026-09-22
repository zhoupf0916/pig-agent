# 对话附件

## API 与数据边界

`POST /v1/attachments` 接收 `{name, contentType?, data}`，data 为严格 base64；每文件最多 4 MiB。返回 `{attachment:{id,name,size,mime,kind,status:'ready',workspacePath,warning?,extractedChars}}`。浏览器已有 cookie 身份认证和同源防护；客户端复用 JSON 远端代理。MIME 根据实际内容检查，不信任客户端声明。

支持 UTF-8 文本/代码、PDF 文本提取、DOCX 正文、PNG/JPEG/GIF/WebP 原件。当前未启用视觉或 OCR：图片明确提示仅保存原件；扫描 PDF 无可提取文字则返回错误，不能假装解析成功。PDF 只取前 100 页，DOCX 不含图片与批注，均返回限制说明。隐藏配置和常见密钥文件名被拒绝。

`GET /v1/attachments` 查询本人附件；`DELETE /v1/attachments/:id` 只删除尚未关联任务的本人草稿。`GET /v1/attachments/:id/download` 允许上传者或关联任务的有权项目成员读取；不暴露跨账号私人附件。`GET /v1/runs/:id/attachments` 返回该任务附件元数据。原件和提取文本存 PostgreSQL，因此控制面切换不丢失。

创建任务与 follow-up 支持 `attachmentIds`（最多 10 个），与任务创建同事务校验附件归属、关联和数量。单会话累计附件最多 8 MiB；账户最多 100 MiB 或 200 个文件。更大的资料需拆分新会话。相同 follow-up 幂等键不能更换附件。

Runner 只接受控制面生成的附件输入，写到 `attachments/<id>-<name>`，文本提取稿另存 `.txt`。输入原件每轮重新物化，编辑应另存成果文件。原件和提取稿不混入成果列表，也不占工作区快照的 512 KiB 单文件上限；续聊继承这些独立持久化输入，不因大图片导致工作区快照截断。

## 解析资源限制

云端镜像安装 python3/poppler-utils。PDF/DOCX 子进程清理环境变量，8 秒壁钟超时、4 秒 CPU、256 MiB 地址空间、1 MiB 输出缓冲区；提取文字最多 200000 字符。DOCX ZIP 限制 2000 项/16 MiB 解压总量/2 MiB document.xml，并拒绝 DTD/实体。临时文件权限 0600，成功失败都清理。不支持的内容返回明确错误。

## 验证

- `pnpm exec vitest run apps/cloud/src/attachment-parser.test.ts`：类型识别、伪造扩展、无效 UTF-8/NUL、大小限制、损坏 DOCX 等。
- `node scripts/smoke-attachments.mjs`：8892 双控制面/双 Runner、mock 模型，共 9 项真实 API/执行验证。上传 TXT/DOCX/PDF/超过 512 KiB 的 PNG，下载原件逐字节一致；在真实 Runner 目录读回 PDF/DOCX marker；跨账号下载和任务注入拒绝；批准、重复审批、续聊与拒绝完成；已关联输入不能删除。
- 可复现样本及结果在 `data/attachment-evidence/`；验收使用本地生成的公开测试资料，不包含用户文档或密钥。

未宣称：图像理解、OCR、复杂版式忠实还原、生产上传吞吐能力。
