---
name: coding-helper
description: 查看工作区代码，做小范围修改，并用读回或有限命令核对。用于编码、缺陷修复或重构。
metadata:
  display-name: 编码协助
keywords: code, coding, bug, refactor, patch, 代码, 修复, 重构
---

# 编码协助

1. 用 `search_files` 和 `read_file` 定位符号，不要猜接口。
2. 用 `update_plan` 列出查看、修改、核对。
3. 用 `edit_file` 或 `apply_patch` 做小改动。
4. 重新阅读改动，或在工作区已有工具时用 `run_shell` 做短检查。
5. 汇总路径和待核对点。不要把密钥写进新文件，不要主动推送远程。
