# Copilot Studio: File-to-Dashboard Agent Skill (no Power BI)

Goal: when a parent or child agent saves an Excel, CSV or PDF file to SharePoint or OneDrive, a Copilot Studio agent reads it, replies with a summary, and gives a link to a live dashboard page (`dashboard.html`).

Copilot has no single built-in feature for this, so it is assembled from three parts. Nothing here has been tested in a tenant.

## Skills the agent needs

| # | Skill | How it is built |
|---|---|---|
| 1 | Notice a new file | Trigger "When a file is created (SharePoint)" on the `Dashboards-Inbox` library |
| 2 | Read the file | CSV: use the file content. Excel: flow action "List rows present in a table" (data must be formatted as a table). PDF: AI Builder "Extract information from documents" |
| 3 | Convert to CSV | Flow action "Create CSV table", then save as `<name>.csv` in the dashboard host folder |
| 4 | Summarize | Agent instructions below (rows, columns, totals, 3 insights, no invented numbers) |
| 5 | Give the dashboard link | Reply with `https://<your-host>/dashboard.html?csv=<csv path>`; the page refreshes itself |
| 6 | Hand-off | Parent agent adds this agent as a connected agent; child agents save files to `Dashboards-Inbox` |

## Architecture

```
Parent/child agent --saves--> SharePoint/OneDrive /Dashboards-Inbox
        |  trigger: file created
        v
Agent flow: read file -> convert to CSV -> copy CSV to dashboard host
        v
Agent replies: summary + link to dashboard.html?csv=...   (page re-reads the CSV on a timer)
```

## Agent instructions (paste into Copilot Studio)

```
You are the Dashboard Builder agent.

When a new file appears in Dashboards-Inbox (xlsx, csv, or pdf):
1. Run the flow to convert it to CSV and publish it.
2. Reply with: file name, row count, column names, total of each numeric
   column, 3 short insights, and the dashboard link.
3. Never invent data. If something cannot be read, say which part and why.
4. If the file has no table or is empty, say so and ask for a new file.
5. If the same filename is uploaded again, update the existing CSV; do not
   create a second dashboard.
```

## Limits
- The page reads CSV from a host that allows cross-origin reads. A SharePoint file link will not work directly (sign-in), and SharePoint downloads .html files instead of showing them.
- PDF extraction depends on how the PDF is made; scanned PDFs need checking.
- The dashboard shows simple charts only (see `NO-POWERBI.md`).

Files here: `BEGINNER-GUIDE.html` (big-font steps), `SIMPLE-EXAMPLE.md`, `NO-POWERBI.md`, `dashboard.html`, `sample-sales.csv`.
