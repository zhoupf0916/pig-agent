---
name: research-report
description: Research a topic from the workspace and optional public URLs, then write a cited report artifact. Use for research, 调研, or report tasks.
keywords: research, report, 调研, 报告, fetch, web, cite
---

# Research → report

Turn a question into a **cited report file**.

## Procedure
1. Search the workspace first (`search_files`, `read_file`). Local notes beat the network.
2. If the user asked for outside context, `http_fetch` public http(s) pages only. Private IPs are blocked; do not fight the SSRF guard.
3. Take short quotes and URLs. If a fetch fails, say so and continue with local sources.
4. Write `reports/YYYY-topic.md` (or the path they named) with:
   - Question
   - Findings (bullets)
   - Sources (workspace paths + URLs)
   - Open questions
5. Re-read the report and list the artifact path in your user-facing summary.

## Rules
- Label speculation. Prefer quoting files you actually read.
- One report file, not a pile of scratch notes, unless the user wants both.
