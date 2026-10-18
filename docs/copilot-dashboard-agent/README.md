# Copilot Studio: File-to-Live-Dashboard Agent Skill

Goal: when a parent or child agent saves an Excel, CSV or PDF file to SharePoint or OneDrive, a Copilot Studio agent builds a live dashboard from it, like Claude's dashboard skill.

Copilot has no single built-in feature for this. Dashboards that Copilot generates from an Excel or CSV file may be static snapshots. This design gets "live" by loading file data into a table (Dataverse or a SharePoint list) and pointing Power BI at that table.

## Architecture

```
Parent agent --(delegates)--> Child agent --saves--> SharePoint/OneDrive folder /Dashboards-Inbox
                                                           |
                                         trigger: file created (SharePoint)
                                                           v
                                              Agent flow "Ingest-File"
                                  1. Get file content + extension
                                  2. Route by type (xlsx / csv / pdf)
                                  3. Parse to rows
                                  4. Upsert rows into Dataverse table (FileData)
                                  5. Write a schema row into FileCatalog
                                                           v
                                Power BI semantic model (DirectQuery / scheduled refresh)
                                                           v
                              Power BI report (live)  <--link--  Agent replies with URL
```

## 1. Folder and trigger
- Library: `Documents/Dashboards-Inbox` on the target SharePoint site. Child agents save here (or in a OneDrive folder synced to it).
- Trigger: Copilot Studio agent, Overview tab, Triggers, "When a file is created (SharePoint)". Alternative: Power Automate "When a file is created (properties only)".
- Trigger filter: file extension is one of `xlsx`, `csv`, `pdf`.

## 2. Data model (Dataverse or SharePoint list)
**FileCatalog**: `FileId`, `FileName`, `FileType`, `SourceUrl`, `UploadedBy`, `UploadedOn`, `ColumnsJson`, `RowCount`, `DashboardUrl`
**FileData** (long format, so any schema fits): `FileId`, `RowNumber`, `ColumnName`, `ValueText`, `ValueNumber`, `ValueDate`

Long format lets one Power BI model serve any file. The report pivots by `FileId`.

## 3. Agent flow "Ingest-File"
| Step | Action |
|---|---|
| 1 | Trigger: file created. Get file content. |
| 2 | Switch on extension. |
| 3a | xlsx: "List rows present in a table". Tell users to format data as a table, or run an Office Script that converts the used range to a table. |
| 3b | csv: `split()` rows and headers, or use the CSV parse connector. |
| 3c | pdf: AI Builder "Extract information from documents", or a prebuilt/custom document model. Keep only tables. Flag low-confidence fields. |
| 4 | Apply Each row, then each column: add a FileData row (use batching or the Dataverse bulk action for large files). |
| 5 | Infer column types (number, date, text) and write `ColumnsJson` to FileCatalog. |
| 6 | Trigger a Power BI dataset refresh (only needed for Import mode). |
| 7 | Return `DashboardUrl = <report url>?filter=FileCatalog/FileId eq '<id>'` to the agent. |

## 4. Power BI
- Connect to Dataverse or SharePoint list in **DirectQuery** (live) or Import with scheduled refresh (every 15-60 minutes).
- Report page template: KPI cards (row count, sum/avg of the top numeric columns), time series (if a date column exists), bar chart by top categorical column, detail table.
- Add a `FileId` slicer. The agent link pre-filters to the new file.
- Publish to a workspace, and share it with the same group that can read the SharePoint library.
- Optionally, Copilot in Power BI can create the visuals from a prompt.

## 5. Agent instructions (paste into Copilot Studio)

```
You are the Dashboard Builder agent.

When a new file appears in Dashboards-Inbox (xlsx, csv, or pdf):
1. Run the Ingest-File flow with the file's ID and type.
2. If the flow returns warnings (low-confidence PDF fields, no table found, mixed types), tell the user exactly which columns or pages are affected.
3. Reply with: file name, row count, column names with detected types, 3 key insights from the data, and the dashboard link.

When a parent or child agent hands you a file:
- Accept a SharePoint or OneDrive URL, or file ID.
- Never invent data. If a value cannot be read, leave it blank and say so.
- If the same filename is uploaded again, update the existing FileId (upsert) rather than creating a duplicate dashboard.

When asked to change a dashboard (for example "add a trend by month"), describe the change, then update the Power BI report or explain what the user must do in Power BI if you lack the action.
```

## 6. Parent and child wiring
- Parent agent: add the Dashboard Builder as a connected agent (Copilot Studio, Agents, Add agent).
- Child agents: save the output file to `Dashboards-Inbox` using a SharePoint "Create file" action, then call the Dashboard Builder with the file URL.
- If the child saves the file but doesn't call the Dashboard Builder, the folder trigger still starts the flow.

## 7. Known limits
- Copilot's own file-generated dashboards (HTML) may embed the data and not refresh. Use the table plus Power BI route when you need true live data.
- PDF extraction is only as good as the document structure. Scanned PDFs need OCR and manual checks.
- Tables with very many cells make Apply Each flows slow. Use Dataverse bulk operations, or load the raw file into a lakehouse for large files.
- "Live" means live relative to the table. If a file is edited in place, re-run ingest on the file-modified trigger as well.
- Licences needed: Microsoft 365 Copilot, Copilot Studio, Power Automate premium (Dataverse), Power BI Pro or Premium.
- This is untested. Check the trigger and connector names in your tenant, since Copilot Studio changes often.
