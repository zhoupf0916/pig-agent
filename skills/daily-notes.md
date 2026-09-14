---
name: daily-notes
description: Capture or reshape daily notes and action items from existing meeting notes or todos. Use when the user asks for a daily note, standup recap, or action-item list.
keywords: daily, standup, todo, 日报, 会议, 待办
---

# Daily notes

## Procedure
1. Scan `notes/` and any `todo` files.
2. Extract open action items and recent decisions.
3. Write `notes/daily-YYYY-MM-DD.md` using today's date if the user did not specify one.
4. Keep sections: **Done / In progress / Next**, plus a short **Decisions** list when relevant.

## Rules
- Link back to source filenames in the workspace.
- Do not mark items done unless the source already says they are done.
