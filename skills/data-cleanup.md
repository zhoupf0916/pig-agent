---
name: data-cleanup
description: Clean messy notes, CSVs, or logs: normalize names, drop empty junk, and leave a change list. Use for cleanup, normalize, or tidy data tasks.
keywords: cleanup, clean, csv, normalize, 清洗, 清理, 去重, tidy
---

# Data cleanup

Normalize messy **text/data files** inside the sandbox.

## Procedure
1. `search_files` and `list_dir` to find csv/tsv/log/txt dumps and duplicate names.
2. Read samples before rewriting. Keep a copy via `move_file` into `archive/` if you will overwrite.
3. Prefer `apply_patch` / `edit_file` for small fixes; `write_file` for a cleaned export (`*.clean.csv` or `notes/cleaned-…`).
4. Do not delete originals unless the user explicitly asked. `delete_file` is last resort for empty junk you created.
5. Write a short `CLEANUP.md` listing before → after paths.

## Rules
- Stay inside the workspace.
- Do not invent rows. If a field is missing, leave it blank and mention it.
- Quote exact filenames in the final summary.
