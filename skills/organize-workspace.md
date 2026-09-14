---
name: organize-workspace
description: Tidy a messy workspace by grouping files into folders, renaming clearly, and leaving a short change summary. Use when the user asks to organize, clean up, or file away notes.
keywords: organize, tidy, 整理, 归类, 归档, move, rename
---

# Organize workspace

You are helping the user tidy their **local workspace**. Stay inside the sandbox.

## Procedure
1. Call `list_dir` on `.` and inspect the current layout.
2. Read leftover or poorly named files before moving them.
3. Propose a simple folder plan (e.g. `notes/`, `drafts/`, `docs/`). Prefer moving over deleting.
4. Use `write_file` / `edit_file` / `run_shell` (`mv`) to apply the plan. Never delete user content unless they explicitly asked.
5. Add or update a `README.md` that describes the new layout in the user's language.
6. Summarize what moved and why.

## Rules
- Do not escape the workspace root.
- Keep names short and obvious.
- If a file already looks well placed, leave it.
