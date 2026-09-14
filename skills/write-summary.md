---
name: write-summary
description: Read the workspace and write a concise summary README or report. Use when the user asks for a summary, overview, or documentation of what is on disk.
---

# Write a workspace summary

## Procedure
1. `list_dir` the workspace (recurse one or two levels as needed).
2. Read the most important text files (notes, drafts, existing README).
3. Write or update `README.md` (or a path the user named) with:
   - one-paragraph purpose
   - inventory of key files
   - suggested next actions pulled from the files themselves
4. Keep the tone factual. Quote dates and names that already appear in the workspace.

## Rules
- Prefer updating an existing README over creating a parallel `SUMMARY.md` unless the user asked for a separate file.
- Do not invent project facts that are not in the files.
