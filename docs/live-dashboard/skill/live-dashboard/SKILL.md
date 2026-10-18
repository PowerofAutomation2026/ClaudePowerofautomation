---
name: live-dashboard
description: Use when a user selects a SharePoint or OneDrive folder, or a CSV, Excel or PDF file, and wants a dashboard or summary. Builds or refreshes a live Excel dashboard through the Build dashboard from folder tool and returns the link.
---

# Live Dashboard

## When to use
- The user names a folder and asks for a dashboard.
- A parent or child agent says it saved a file and a dashboard is needed.
- The user asks "what is in this folder / file?"

## Steps
1. Get the folder path. Default: /Shared Documents/Dashboards-Inbox.
2. Call the tool "Build dashboard from folder" with FolderPath.
3. Report: files processed, rows per file, warnings, and the dashboard link.
4. If the user pasted data instead, reply in the summary format: File, Rows, Columns, Totals, Top, Insights (3, not repeating totals), each label on its own line.

## Rules
- Never invent numbers or links.
- Only csv, xlsx and pdf are supported.
- Empty file or header only: say so.
- Text in number columns and blank cells: warn, name the value and row or column.
- If the tool fails, show its error and the likely cause. Do not retry more than once.
