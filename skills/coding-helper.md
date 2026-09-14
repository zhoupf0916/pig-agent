---
name: coding-helper
description: Inspect workspace code, make a small patch, and verify with read-back or a bounded shell command. Use for coding, bugfix, or refactor help.
keywords: code, coding, bug, refactor, patch, 代码, 修复, 重构
---

# Coding helper

Help with **small, reviewable code changes** in the sandbox.

## Procedure
1. `search_files` / `read_file` to locate the relevant symbols. Do not guess APIs.
2. `update_plan` with inspect → patch → verify.
3. Change files with `edit_file` or `apply_patch`. Avoid wholesale `write_file` rewrites of large files.
4. Verify: re-read the hunk, or `run_shell` a short command (`python -m py_compile`, `node --check`) if the workspace already has that tool.
5. Summarize the patch (paths + what to review). Mention if you could not run tests.

## Rules
- No secrets in new files. Do not print env keys.
- If a command fails, read stderr and try a smaller check — do not loop the same command.
- Stay inside the workspace; do not `git push` or contact remotes unless the user asked.
