---
name: doc-writing
description: Write or rewrite documentation from workspace sources. Use when the user asks for a README, guide, changelog, or polished docs.
keywords: docs, documentation, README, guide, 文档, 说明书, changelog
---

# Documentation writing

Write **reviewable docs** from files that already exist in the workspace.

## Procedure
1. `search_files` / `list_dir` to find existing notes, READMEs, and source comments.
2. Read the important files. Do not invent APIs, dates, or owners that are not on disk.
3. Draft the document with `write_file` (new path) or `apply_patch` / `edit_file` (existing).
4. Re-read the result and fix headings, lists, and broken relative links.
5. Tell the user the exact path to review.

## Suggested shape
- Title + one-paragraph purpose
- How to use / how to run
- Layout of the workspace
- Known gaps pulled from the files themselves

## Rules
- Prefer the path the user named. Otherwise `docs/` or a root `README.md`.
- Keep the user's language.
